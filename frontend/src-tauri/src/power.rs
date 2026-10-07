//! Native sleep prevention and suspend/resume evidence, independent of WebViews.
use std::sync::{atomic::{AtomicU64, Ordering}, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Clone, Copy, Debug)]
struct SleepInterval { started_at: u64, ended_at: u64 }

struct Notifications {
    sleeping_since: AtomicU64,
    sender: mpsc::Sender<SleepInterval>,
}
impl Notifications {
    fn suspend(&self) {
        let _ = self.sleeping_since.compare_exchange(0, now_ms(), Ordering::SeqCst, Ordering::SeqCst);
    }
    fn resume(&self) {
        let started_at = self.sleeping_since.swap(0, Ordering::SeqCst);
        let ended_at = now_ms();
        if started_at > 0 && ended_at > started_at {
            let _ = self.sender.send(SleepInterval { started_at, ended_at });
        }
    }
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

pub fn start(app: tauri::AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    std::thread::spawn(move || {
        let (sender, receiver) = mpsc::channel();
        platform::observe(Notifications { sleeping_since: AtomicU64::new(0), sender });
        let Ok(client) = reqwest::blocking::Client::builder().no_proxy()
            .timeout(Duration::from_secs(2)).build() else { return; };
        let mut blocker = platform::Blocker::default();
        let mut pending = std::collections::VecDeque::new();
        loop {
            pending.extend(receiver.try_iter());
            while pending.len() > 64 { pending.pop_front(); }
            let instance = crate::backend::read_ready_file();
            let prevent = instance.as_ref().and_then(|instance| {
                client.get(format!("{}/api/v1/service/power", instance.base_url)).send().ok()
                    .filter(|response| response.status().is_success())?
                    .json::<serde_json::Value>().ok()?.get("preventSleep")?.as_bool()
            }).unwrap_or(false);
            if let Err(error) = blocker.set(prevent) {
                log::warn!("录制防休眠申请失败: {error}");
            }
            if let Some(instance) = instance {
                // Retry in order if the backend is still resuming or restarting.
                while let Some(interval) = pending.front() {
                    let result = client.post(format!("{}/api/v1/service/system-sleep", instance.base_url))
                        .json(&serde_json::json!({ "startedAt": interval.started_at, "endedAt": interval.ended_at }))
                        .send();
                    if !result.is_ok_and(|response| response.status().is_success()) { break; }
                    pending.pop_front();
                }
            }
            // The handle keeps the shell alive; process exit releases all native assertions.
            let _ = app.state::<crate::ShellState>();
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = app;
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Notifications;
    use std::ffi::{c_char, c_void};
    use std::ptr;
    type Ref = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: Ref, text: *const c_char, encoding: u32) -> Ref;
        fn CFRelease(value: Ref);
        fn CFRunLoopGetCurrent() -> Ref;
        fn CFRunLoopAddSource(run_loop: Ref, source: Ref, mode: Ref);
        fn CFRunLoopRun();
        static kCFRunLoopCommonModes: Ref;
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(kind: Ref, level: u32, name: Ref, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
        fn IORegisterForSystemPower(context: *mut c_void, port: *mut *mut c_void,
            callback: extern "C" fn(*mut c_void, u32, u32, *mut c_void), notifier: *mut u32) -> u32;
        fn IONotificationPortGetRunLoopSource(port: *mut c_void) -> Ref;
        fn IOAllowPowerChange(root: u32, notification: isize) -> i32;
    }
    #[derive(Default)]
    pub struct Blocker { id: Option<u32> }
    impl Blocker {
        pub fn set(&mut self, prevent: bool) -> Result<(), String> {
            if prevent && self.id.is_none() {
                unsafe {
                    let kind = CFStringCreateWithCString(ptr::null(), c"PreventUserIdleSystemSleep".as_ptr(), 0x08000100);
                    let name = CFStringCreateWithCString(ptr::null(), c"Live Recorder recording in progress".as_ptr(), 0x08000100);
                    let mut id = 0;
                    let result = IOPMAssertionCreateWithName(kind, 255, name, &mut id);
                    CFRelease(kind); CFRelease(name);
                    if result != 0 { return Err(format!("IOPMAssertionCreateWithName: {result}")); }
                    self.id = Some(id);
                }
            } else if !prevent {
                if let Some(id) = self.id {
                    let result = unsafe { IOPMAssertionRelease(id) };
                    if result != 0 { return Err(format!("IOPMAssertionRelease: {result}")); }
                    self.id = None;
                }
            }
            Ok(())
        }
    }
    impl Drop for Blocker { fn drop(&mut self) { let _ = self.set(false); } }
    struct Context { notifications: Notifications, root: u32 }
    extern "C" fn callback(context: *mut c_void, _: u32, message: u32, argument: *mut c_void) {
        let context = unsafe { &*(context as *const Context) };
        match message {
            0xe0000270 => { unsafe { IOAllowPowerChange(context.root, argument as isize); } }
            0xe0000280 => {
                context.notifications.suspend();
                unsafe { IOAllowPowerChange(context.root, argument as isize); }
            }
            0xe0000300 => context.notifications.resume(),
            _ => {}
        }
    }
    pub fn observe(notifications: Notifications) {
        std::thread::spawn(move || unsafe {
            let mut context = Box::new(Context { notifications, root: 0 });
            let mut port = ptr::null_mut();
            let mut notifier = 0;
            context.root = IORegisterForSystemPower((&mut *context as *mut Context).cast(), &mut port, callback, &mut notifier);
            if context.root == 0 { log::warn!("无法订阅 macOS 系统休眠通知"); return; }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), IONotificationPortGetRunLoopSource(port), kCFRunLoopCommonModes);
            // Context and registration live on this thread until application exit.
            CFRunLoopRun();
        });
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::Notifications;
    use std::ffi::c_void;
    use std::ptr;
    #[link(name = "kernel32")]
    extern "system" { fn SetThreadExecutionState(flags: u32) -> u32; }
    #[repr(C)]
    struct Subscribe { callback: extern "system" fn(*mut c_void, u32, *mut c_void) -> u32, context: *mut c_void }
    #[link(name = "powrprof")]
    extern "system" {
        fn PowerRegisterSuspendResumeNotification(flags: u32, recipient: *mut c_void, handle: *mut *mut c_void) -> u32;
    }
    #[derive(Default)]
    pub struct Blocker { active: bool }
    impl Blocker {
        pub fn set(&mut self, prevent: bool) -> Result<(), String> {
            if !prevent && !self.active { return Ok(()); }
            // Reassert on the same dedicated thread, including after Modern Standby resumes.
            let flags = 0x80000000 | if prevent { 1 } else { 0 };
            if unsafe { SetThreadExecutionState(flags) } == 0 { return Err("SetThreadExecutionState".into()); }
            self.active = prevent;
            Ok(())
        }
    }
    impl Drop for Blocker { fn drop(&mut self) { let _ = self.set(false); } }
    extern "system" fn callback(context: *mut c_void, event: u32, _: *mut c_void) -> u32 {
        let notifications = unsafe { &*(context as *const Notifications) };
        match event {
            4 => notifications.suspend(),
            7 | 18 => notifications.resume(),
            _ => {}
        }
        0
    }
    pub fn observe(notifications: Notifications) {
        let context = Box::into_raw(Box::new(notifications));
        let subscription = Box::into_raw(Box::new(Subscribe { callback, context: context.cast() }));
        let mut registration = ptr::null_mut();
        let result = unsafe { PowerRegisterSuspendResumeNotification(2, subscription.cast(), &mut registration) };
        if result != 0 {
            unsafe { drop(Box::from_raw(context)); drop(Box::from_raw(subscription)); }
            log::warn!("无法订阅 Windows 系统休眠通知: {result}");
        }
        // Keep both callback context and subscription alive for the registration's lifetime.
        // Successful registration and callback context remain valid until process exit.
    }
}
