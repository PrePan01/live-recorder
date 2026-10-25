import type { Clock } from "../core/clock.js";

export type QmsgSender = (
  key: string,
  text: string,
  signal: AbortSignal,
) => Promise<void>;
export type QmsgResult = "submitted" | "skipped";

export function qmsgText(text: string): string {
  return Array.from(
    text
      .replace(/(?:https?:\/\/|www\.)\S+/gi, "（链接已省略）")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "（地址已省略）")
      .replace(
        /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi,
        "（链接已省略）",
      )
      .replace(/\d{2,}/g, "（数字已省略）"),
  )
    .slice(0, 1800)
    .join("");
}

export const sendQmsg: QmsgSender = async (key, text, signal) => {
  try {
    const response = await fetch(
      `https://qmsg.zendee.cn/v3/send/${encodeURIComponent(key)}`,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ msg: qmsgText(text) }),
      },
    );
    const body = (await response.json()) as { success?: boolean };
    if (!response.ok || body.success !== true) throw new Error("rejected");
  } catch {
    // Never propagate fetch errors: the request URL contains the secret Key.
    throw new Error("QQ 推送提交失败，请检查 Qmsg 绑定、额度与网络");
  }
};

type Job = {
  text: string;
  allowed: () => boolean;
  epoch: number;
  resolve: (value: QmsgResult) => void;
  reject: (error: Error) => void;
};

/** One shared, bounded FIFO for event and test pushes. No retries after uncertain results. */
export class QmsgQueue {
  private jobs: Job[] = [];
  private running = false;
  private closed = false;
  private epoch = 0;
  private idleWaiters: Array<() => void> = [];
  get disposed(): boolean {
    return this.closed;
  }
  private timer: unknown;
  private controller: AbortController | undefined;
  private lastAttempt = new Map<string, number>();
  get busy(): boolean {
    return this.running || this.jobs.length > 0;
  }

  constructor(
    private clock: Clock,
    private key: () => Promise<string | null>,
    private sender: QmsgSender = sendQmsg,
    private warning: () => void = () => {},
  ) {}

  enqueue(
    text: string,
    allowed: () => boolean = () => true,
  ): Promise<QmsgResult> {
    if (this.closed) return Promise.reject(new Error("QQ 通知服务已关闭"));
    if (this.jobs.length + Number(this.running) >= 100) {
      this.warning();
      return Promise.reject(new Error("QQ 推送队列已满，请稍后重试"));
    }
    const promise = new Promise<QmsgResult>((resolve, reject) => {
      this.jobs.push({
        text: qmsgText(text),
        allowed,
        epoch: this.epoch,
        resolve,
        reject,
      });
    });
    void this.pump();
    return promise;
  }

  invalidate(): void {
    this.epoch++;
    for (const job of this.jobs.splice(0)) job.resolve("skipped");
    this.wake?.();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.invalidate();
    this.controller?.abort();
    // Wake a spacing wait so an active job can settle before teardown.
    this.wake?.();
    if (this.running)
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
  private wake: (() => void) | undefined;

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.running = true;
    const valid = () =>
      !this.closed && job.epoch === this.epoch && job.allowed();
    try {
      if (!valid()) {
        job.resolve("skipped");
        return;
      }
      const key = await this.key();
      if (!key || !valid()) {
        job.resolve("skipped");
        return;
      }
      const delay = Math.max(
        0,
        (this.lastAttempt.get(key) ?? -Infinity) + 5000 - this.clock.now(),
      );
      if (delay)
        await new Promise<void>((resolve) => {
          this.wake = () => {
            this.clock.clearTimeout(this.timer);
            this.wake = undefined;
            resolve();
          };
          this.timer = this.clock.setTimeout(() => this.wake?.(), delay);
        });
      const currentKey = await this.key();
      if (!valid() || currentKey !== key) {
        job.resolve("skipped");
        return;
      }
      this.lastAttempt.set(key, this.clock.now());
      this.controller = new AbortController();
      let timeout: unknown;
      try {
        await Promise.race([
          this.sender(key, job.text, this.controller.signal),
          new Promise<never>((_, reject) => {
            this.controller!.signal.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            );
          }),
          new Promise<never>((_, reject) => {
            timeout = this.clock.setTimeout(() => {
              this.controller?.abort();
              reject(new Error("QQ 推送请求超时，请稍后检查 QQ"));
            }, 10_000);
          }),
        ]);
        job.resolve("submitted");
      } finally {
        if (timeout !== undefined) this.clock.clearTimeout(timeout);
      }
    } catch {
      job.reject(new Error("QQ 推送提交失败，请检查 Qmsg 绑定、额度与网络"));
    } finally {
      this.controller = undefined;
      this.running = false;
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
      void this.pump();
    }
  }
}
