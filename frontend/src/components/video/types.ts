export interface VideoPlayerProps {
  roomId: string;
  muted?: boolean;
  /** Hover cover: silent, no controls/retries, bounded buffers. */
  thumbnail?: boolean;
  onPreviewError?: () => void;
  /** 平台：douyin 无 Cookie 受限时加载超时给明确提示 */
  platform?: "bilibili" | "douyin";
  /** 竖屏墙：不写死宽高比，画面撑满容器高度并按真实比例显示。 */
  fill?: boolean;
  /** 直播墙窗口模式中供重复格子镜像主画面。 */
  onVideoElementChange?: (element: HTMLVideoElement | null) => void;
  /** 预览弹窗：上报流的真实宽高比（宽/高），供容器按真实比例排版。 */
  onStreamAspectRatio?: (ratio: number) => void;
  /** 预览弹窗：fill 未开启时用于排版的宽高比；不传保持 16:9（直播墙不动）。 */
  aspectRatio?: number;
  /** 预览切流期间保留最后一帧，直到新源真正呈现画面。 */
  preserveFrameOnSwitch?: boolean;
  /** 跳播回看源：携带目标时间和解码关键帧时间；空=实时直播。 */
  seek?: {
    url: string;
    generation: number;
    second: number;
    startSecond: number;
  } | null;
  /** 回看播到已写尾部 →调用方切回实时。 */
  onSeekTail?: () => void;
  /** 回看首帧渲染（松手→首帧掍表打点），携带代际号防旧代际串打点。 */
  onSeekFirstFrame?: (generation: number, elapsed: number) => void;
  /** 失败必须释放父级在途状态；重试重新预热快照，而不是复用已过期的 URL。 */
  onSeekError?: (generation: number, second: number) => void;
  onSeekRetry?: () => void;
  /** 实时流首帧（切实时段掍表打点）。 */
  onLiveFirstFrame?: () => void;
}
