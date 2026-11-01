// 校验片段导出的文件名，供直接导出和批量导出队列共用。
import { AppError } from "../types/error.js";

/**
 * 片段命名校验：必填 1-120 字、文件名非法字符直接拒绝（用户重输），
 * 兼容误带的视频扩展名（与历史改名同口径去掉后缀）。
 */
export function validateClipName(raw: string, recordingId: string): string {
  const base = (typeof raw === "string" ? raw : "")
    .trim()
    .replace(/\.(?:flv|mp4|mkv|ts|webm)$/i, "")
    .trim();
  if (!base || base.length > 120) {
    throw new AppError("CONFIG_INVALID", "片段名称需为 1-120 个字符", {
      recordingId,
    });
  }
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(base)) {
    throw new AppError(
      "CONFIG_INVALID",
      '片段名称不能包含 \\ / : * ? " < > | 等字符',
      { recordingId },
    );
  }
  return base;
}
