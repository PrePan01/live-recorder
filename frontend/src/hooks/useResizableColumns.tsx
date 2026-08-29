import { useMemo, useState } from 'react';
import type { ColumnsType } from 'antd/es/table';
import ResizableTitle from '../components/ResizableTitle';

/**
 * 让表格列宽可手动拖拽调整。
 * 用法：const { columns: resizedColumns, components } = useResizableColumns(columns);
 * 把 resizedColumns 传给 Table columns，components 传给 Table components。
 * 注意：所有列均渲染可拖拽手柄。
 */
export function useResizableColumns<T>(columns: ColumnsType<T>) {
  const [widths, setWidths] = useState<Record<string, number>>({});

  const resizedColumns = useMemo(
    () =>
      columns.map((col) => {
        const colType = col as { key?: React.Key; dataIndex?: unknown; width?: number; title?: React.ReactNode; fixed?: unknown };
        const key = String(colType.key ?? (typeof colType.dataIndex === 'string' ? colType.dataIndex : '') ?? '');
        // 所有列均支持拖拽：无显式 width 的列给默认 140（操作列等固定列也允许调整）。
        const base = Number(colType.width) || 140;
        const current = widths[key] ?? base;
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
    [columns, widths],
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