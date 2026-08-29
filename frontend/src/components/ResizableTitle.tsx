import { useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  width: number;
  minWidth: number;
  onResize: (width: number) => void;
  className?: string;
  style?: React.CSSProperties;
  [key: string]: unknown;
}

/**
 * 可拖拽调整宽度的表头单元格：右侧手柄拖拽更新列宽。
 * 用于实现表格列宽手动调整（无第三方依赖，原生 mousedown/mousemove）。
 */
export default function ResizableTitle({ children, width, minWidth = 60, onResize, className, style, ...rest }: Props) {
  const startX = useRef(0);
  const startW = useRef(width);
  const raf = useRef<number | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    startW.current = width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(minWidth, startW.current + (ev.clientX - startX.current));
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => onResize(next));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <th
      className={className}
      {...rest}
      style={{
        ...style,
        position: 'relative',
        paddingRight: 12,
        minWidth,
        width,
      }}
    >
      {children}
      <span
        onMouseDown={onMouseDown}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 8,
          height: '100%',
          cursor: 'col-resize',
          userSelect: 'none',
          touchAction: 'none',
        }}
      />
    </th>
  );
}