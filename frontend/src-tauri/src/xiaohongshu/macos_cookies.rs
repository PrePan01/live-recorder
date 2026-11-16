use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2_foundation::{
    ns_string, NSArray, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieName, NSHTTPCookiePath,
    NSHTTPCookieSecure, NSHTTPCookieValue, NSMutableDictionary, NSString,
};
use objc2_web_kit::{WKHTTPCookieStore, WKWebView};
use std::{ptr::NonNull, sync::mpsc, time::Duration};
use tauri::{webview::Cookie, WebviewWindow};

fn with_cookie_store<T: Send + 'static>(
    view: &WebviewWindow,
    operation: impl FnOnce(&WKHTTPCookieStore, mpsc::Sender<Result<T, String>>) + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    // Wry's synchronous cookie methods spin a nested AppKit event loop, which
    // can re-enter Tao's redraw handler while it still holds the event-loop lock.
    view.with_webview(move |platform| {
        // Tauri provides a live WKWebView pointer on the main thread for this closure.
        let view: &WKWebView = unsafe { &*platform.inner().cast() };
        let store = unsafe { view.configuration().websiteDataStore().httpCookieStore() };
        operation(&store, sender);
    })
    .map_err(|_| "无法访问小红书官网会话")?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "等待小红书官网会话超时")?
}

pub(super) fn read(view: &WebviewWindow) -> Result<Vec<Cookie<'static>>, String> {
    with_cookie_store(view, |store, sender| unsafe {
        store.getAllCookies(&RcBlock::new(
            move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
                let cookies = cookies
                    .as_ref()
                    .to_vec()
                    .into_iter()
                    .filter_map(|cookie| {
                        let domain = cookie.domain().to_string();
                        let host = domain.trim_start_matches('.');
                        if host != "xiaohongshu.com" && !host.ends_with(".xiaohongshu.com") {
                            return None;
                        }
                        Some(
                            Cookie::build((cookie.name().to_string(), cookie.value().to_string()))
                                .domain(domain)
                                .path(cookie.path().to_string())
                                .secure(cookie.isSecure())
                                .http_only(cookie.isHTTPOnly())
                                .build(),
                        )
                    })
                    .collect();
                let _ = sender.send(Ok(cookies));
            },
        ));
    })
}

pub(super) fn update(
    view: &WebviewWindow,
    cookie: Cookie<'static>,
    delete: bool,
) -> Result<(), String> {
    with_cookie_store(view, move |store, sender| unsafe {
        let properties = NSMutableDictionary::<NSString, AnyObject>::from_slices(
            &[
                NSHTTPCookieName,
                NSHTTPCookieValue,
                NSHTTPCookiePath,
                NSHTTPCookieDomain,
            ],
            &[
                &*NSString::from_str(cookie.name()),
                &*NSString::from_str(cookie.value()),
                &*NSString::from_str(cookie.path().unwrap_or("/")),
                &*NSString::from_str(cookie.domain().unwrap_or_default()),
            ],
        );
        if cookie.secure() == Some(true) {
            properties.insert(NSHTTPCookieSecure, ns_string!("TRUE"));
        }
        if cookie.http_only() == Some(true) {
            properties.insert(ns_string!("HttpOnly"), ns_string!("TRUE"));
        }
        let Some(cookie) = NSHTTPCookie::cookieWithProperties(&properties) else {
            let _ = sender.send(Err("小红书授权格式无效".into()));
            return;
        };
        let complete = RcBlock::new(move || {
            let _ = sender.send(Ok(()));
        });
        if delete {
            store.deleteCookie_completionHandler(&cookie, Some(&complete));
        } else {
            store.setCookie_completionHandler(&cookie, Some(&complete));
        }
    })
}
