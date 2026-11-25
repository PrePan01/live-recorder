export function topModalDialog(doc: Document = document): HTMLElement | undefined {
  let top: HTMLElement | undefined;
  let topZIndex = -Infinity;
  for (const dialog of doc.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')) {
    if (!dialog.getClientRects().length) continue;
    const wrapper = dialog.closest(".ant-modal-wrap, .ant-drawer") ?? dialog;
    const style = doc.defaultView?.getComputedStyle(wrapper);
    if (style?.visibility === "hidden") continue;
    const zIndex = Number(style?.zIndex) || 0;
    if (zIndex >= topZIndex) {
      top = dialog;
      topZIndex = zIndex;
    }
  }
  return top;
}
