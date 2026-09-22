/** 状态栏磁盘区域的展示决策（目录可用性优先于磁盘空间语义）。 */
export interface DiskDisplay {
  text: string;
  /** 红字展示 */
  danger: boolean;
  /** 磁盘空间不足（仅目录可用时有意义） */
  spaceDanger: boolean;
  showProgress: boolean;
  showCleanup: boolean;
}

/** 仅显式 false 视为不可用；undefined（旧后端/未取到）不触发警告。 */
export function isDirectoryUnavailable(
  directoryAvailable: boolean | undefined,
): boolean {
  return directoryAvailable === false;
}

const LOW_SPACE_BYTES = 20_000_000_000;
const LOW_SPACE_RATIO = 0.1;

export function diskDisplay(
  directoryAvailable: boolean | undefined,
  freeBytes: number,
  totalBytes: number,
): DiskDisplay {
  if (isDirectoryUnavailable(directoryAvailable)) {
    return {
      text: "磁盘不可用",
      danger: true,
      spaceDanger: false,
      showProgress: false,
      showCleanup: false,
    };
  }
  const total = totalBytes > 0 ? totalBytes : 1;
  const freeRatio = freeBytes / total;
  const spaceDanger =
    freeBytes < LOW_SPACE_BYTES || freeRatio < LOW_SPACE_RATIO;
  return spaceDanger
    ? {
        text: "⚠ 磁盘空间不足",
        danger: true,
        spaceDanger: true,
        showProgress: true,
        showCleanup: true,
      }
    : {
        text: "磁盘可用",
        danger: false,
        spaceDanger: false,
        showProgress: true,
        showCleanup: false,
      };
}
