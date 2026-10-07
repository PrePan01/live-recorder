/** One hover decoder per page; brief pointer passes never open a stream. */
export function createHoverPreviewController(delay = 350) {
  let active: symbol | null = null;
  let pending: symbol | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const clearPending = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isActive(owner: symbol) { return active === owner; },
    request(owner: symbol, eligible: () => boolean) {
      clearPending();
      if (active !== null) { active = null; notify(); }
      pending = owner;
      timer = setTimeout(() => {
        timer = null;
        pending = null;
        if (!eligible()) return;
        active = owner;
        notify();
      }, delay);
    },
    cancel(owner: symbol) {
      if (pending === owner) clearPending();
      if (active === owner) { active = null; notify(); }
    },
  };
}

export const hoverPreview = createHoverPreviewController();
