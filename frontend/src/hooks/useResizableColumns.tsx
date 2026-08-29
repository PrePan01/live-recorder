import { useMemo, useRef, useState } from 'react';
import type { ColumnsType } from 'antd/es/table';
import ResizableTitle from '../components/ResizableTitle';

/**
 * 让表格列宽可手动拖拽调整。
 * 用法：const { columns: resizedColumns, components } = useResizableColumns(columns);
 * 把 resizedColumns 传给 Table columns，components 传给 Table components。
 * 注意：原列需含 width 才会渲染可拖拽手柄。
 */
export function useResizableColumns<T>(columns: ColumnsType<T>) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const resizedColumns = useMemo(
    () =>
      columns.map((col) => {
        const colType = col as { key?: React.Key; dataIndex?: unknown; width?: number; title?: React.ReactNode };
        const key = String(colType.key ?? (typeof colType.dataIndex === 'string' ? colType.dataIndex : '') ?? '');
        const base = Number(colType.width) || undefined;
        if (base === undefined) return col;
        const current = widthsRef.current[key] ?? base;
        return {
          ...col,
          width: current,
          onHeaderCell: () => ({
            width: current,
            minWidth: Math.min(base, 60),
            onResize: (w: number) => setWidths((prev) => ({ ...prev, [key]: w })),
          }),
        };
      }),
    [columns],
  );

  const components = useMemo(
    () => ({
      header: {
        cell: (props: {
          children: React.ReactNode;
          className?: string;
          style?: React.CSSProperties;
          width?: number;
          minWidth?: number;
          onResize?: (w: number) => void;
          'data-key'?: string;
        }) =>
          props.onResize && props.width ? (
            <ResizableTitle
              width={props.width}
              minWidth={props.minWidth ?? 60}
              onResize={props.onResize}
              className={props.className}
              style={props.style}
            >
              {props.children}
            </ResizableTitle>
          ) : (
            <th className={props.className} style={props.style}>
              {props.children}
            </th>
          ),
      },
    }),
    [],
  );

  return { columns: resizedColumns as ColumnsType<T>, components };
}