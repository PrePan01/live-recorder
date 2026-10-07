/** 使用截止时间计算剩余秒数，避免定时器延迟使倒计时累积漂移。 */
export function startAutoKeepCountdown(
  onTick: (seconds: number) => void,
  onElapsed: () => void,
): () => void {
  const deadline = Date.now() + 10_000;
  const timer = setInterval(() => {
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    onTick(seconds);
    if (seconds === 0) {
      clearInterval(timer);
      onElapsed();
    }
  }, 1000);
  return () => clearInterval(timer);
}
