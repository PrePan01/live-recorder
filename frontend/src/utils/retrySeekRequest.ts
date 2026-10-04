import { ApiError } from "../types/error";

/** 只重试服务明确标为可重试的失败；换位置/关框会取消请求和退避计时。 */
export async function retrySeekRequest<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  delays = [500, 1500, 3000],
): Promise<T> {
  const abortError = () =>
    signal.reason ?? new DOMException("Request aborted", "AbortError");
  const check = () => {
    if (signal.aborted) throw abortError();
  };
  for (let attempt = 0; ; attempt += 1) {
    check();
    try {
      const result = await request();
      check();
      return result;
    } catch (error) {
      check();
      if (
        !(error instanceof ApiError) ||
        !error.retryable ||
        attempt >= delays.length
      )
        throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(finish, delays[attempt]);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(abortError());
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
