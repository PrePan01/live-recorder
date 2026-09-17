import { testOpenList, updateOpenListConfig } from '../api/openlist';
import { ApiError } from '../types/error';

export interface AutoUploadCheckResult {
  /** 最终应呈现的开关状态：检测未通过时为 false（已自动关闭）。 */
  enabled: boolean;
  /** 需要提示给用户的原因；通过时为 undefined。 */
  error?: string;
}

/** 影响 WebDAV 连通性的字段：改动它们需要重新检测连接（目录模板、删除策略等不影响）。 */
export const CONNECTION_FIELDS = ['serverUrl', 'username', 'token'] as const;

/** 本次变更是否动了地址/凭证（开关已开时才需要复检）。 */
export function affectsConnection(changed: Record<string, unknown>): boolean {
  return CONNECTION_FIELDS.some((field) => field in changed);
}

/** 服务端 message 比按码映射的通用文案更具体（认证失败/地址无效/网络不可达），优先展示。 */
function reason(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

/**
 * 「自动上传」的连接检测：先保存当前配置，再探测 WebDAV，检测不通过就把开关关回去，
 * 避免「开关开着但连不上」——录制完成后上传只会一直失败。
 *
 * 两个场景共用：① 打开开关时；② 开关已开但改动地址/凭证后复检。
 * 先保存再检测，保证检测用的是刚填写的地址/令牌（逐字段自动保存是异步的，不能依赖已落盘）。
 */
export async function saveAndVerifyAutoUpload(
  save: () => Promise<void>,
): Promise<AutoUploadCheckResult> {
  try {
    await save();
  } catch (error) {
    return { enabled: false, error: reason(error, '保存失败') };
  }
  try {
    await testOpenList();
  } catch (error) {
    // 关闭动作本身也可能失败（服务不可用等），仍然要把开关交回关闭态，不能抛出中断。
    await updateOpenListConfig({ enabled: false }).catch(() => undefined);
    return {
      enabled: false,
      error: `连接检测未通过，已自动关闭自动上传：${reason(error, '未知错误')}`,
    };
  }
  return { enabled: true };
}
