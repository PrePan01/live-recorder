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
        // 所有列均支持拖拽：无显式 width 的列给默认 140。fixed 列保持固定（不拖拽，避免与滚动冲突）。
        if (colType.fixed !== undefined) return col;
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
        cell: (props: Record<string, unknown> & {
          children?: React.ReactNode;
          className?: string;
          style?: React.CSSProperties;
          width?: number;
          minWidth?: number;
          onResize?: (w: number) => void;
        }) => {
          // 透传其余 props（含 antd fixed 列定位所需属性），避免自定义组件覆盖后丢失固定逻辑。
          const { onResize, width, minWidth, children, className, style, ...rest } = props;
          return onResize && width ? (
            <ResizableTitle
              width={width}
              minWidth={minWidth ?? 60}
              onResize={onResize}
              className={className}
              style={style}
              {...rest}
            >
              {children}
            </ResizableTitle>
          ) : (
            <th className={className} style={style} {...rest}>
              {children}
            </th>
          );
        },
      },
    }),
    [],
  );

  return { columns: resizedColumns as ColumnsType<T>, components };
}