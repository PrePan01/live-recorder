/** 实际编码方式枚举 → 显示词（硬件(XX)/软件(x264)/无损复制）。 */
const ENCODER_LABEL: Record<string, string> = {
  h264_videotoolbox: '硬件(VideoToolbox)',
  h264_nvenc: '硬件(NVENC)',
  h264_qsv: '硬件(QSV)',
  h264_amf: '硬件(AMF)',
  libx264: '软件(x264)',
  copy: '无损复制',
};

export function encoderLabel(actualEncoder?: string | null): string {
  if (!actualEncoder) return '';
  return ENCODER_LABEL[actualEncoder] ?? actualEncoder;
}
