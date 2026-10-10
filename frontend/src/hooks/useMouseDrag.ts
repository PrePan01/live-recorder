import { useCallback, useEffect, useRef } from "react";
import { listenMouseDrag, type MouseDragHandlers } from "../utils/mouseDrag";

export function useMouseDrag() {
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  return useCallback(({ onMove, onEnd, onCancel }: MouseDragHandlers) => {
    cancelRef.current?.();
    cancelRef.current = listenMouseDrag({
      onMove,
      onEnd: (event) => {
        cancelRef.current = null;
        onEnd(event);
      },
      onCancel: () => {
        cancelRef.current = null;
        onCancel?.();
      },
    });
  }, []);
}
