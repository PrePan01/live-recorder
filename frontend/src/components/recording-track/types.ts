import { type ReactNode, type Ref } from "react";
import type { RecordingGap, RecordingMarker } from "../../types/recording";

import { type RecordingTrackMode } from "../../utils/recordingTimeline";

export type RecordingTrackProps = {
  elapsedSeconds: number;
  /** 文件回放使用真实时长，选区调整不跳播。 */
  mode?: RecordingTrackMode;
  seekDisabled?: boolean;
  toolbar?: ReactNode;
  markerNavigationRef?: Ref<HTMLSpanElement>;
  /** 标记列表随时间轴共同展开和收起。 */
  children?: ReactNode;
  markers: RecordingMarker[];
  editable?: boolean;
  busy?: boolean;
  onAdd?: (text: string, positionSeconds: number) => Promise<void>;
  onQuickAdd?: () => void;
  addingMarker?: boolean;
  quickAddDisabled?: boolean;
  onEdit?: (id: string, text: string) => Promise<void>;
  onMove?: (id: string, positionSeconds: number) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onExport?: (start: number, end: number) => void | Promise<void>;
  onCollapsedChange?: (collapsed: boolean) => void;
  onSeekIntent?: (second: number) => void;
  onSeekCommit?: (target: number | "live", indicatorSecond?: number) => void;
  onReturnToLive?: () => void;
  previewMode?: "live" | "history";
  previewSecond?: number;
  previewLoading?: boolean;
  seekHint?: string;
  /** 中断缺口（缺口标记层）：positionMs=拼接位、尾缺=片尾处；无位缺口不画（不伪造位置）。 */
  gaps?: RecordingGap[];
};
