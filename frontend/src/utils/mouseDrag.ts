export interface MouseDragHandlers {
  onMove: (event: MouseEvent) => void;
  onEnd: (event: MouseEvent) => void;
  onCancel?: () => void;
}

/** Listen only for the lifetime of one gesture. Blur cancels interrupted drags. */
export function listenMouseDrag(
  { onMove, onEnd, onCancel }: MouseDragHandlers,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let active = true;
  const detach = () => {
    active = false;
    target.removeEventListener("mousemove", onMove);
    target.removeEventListener("mouseup", finish);
    target.removeEventListener("blur", cancel);
  };
  const cancel = () => {
    if (!active) return;
    detach();
    onCancel?.();
  };
  const finish = (event: MouseEvent) => {
    if (!active) return;
    detach();
    onEnd(event);
  };
  target.addEventListener("mousemove", onMove);
  target.addEventListener("mouseup", finish);
  target.addEventListener("blur", cancel);
  return cancel;
}
