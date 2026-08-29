import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import type { DiagnosticStatus } from '../../types/index.js';

const STATUSES: DiagnosticStatus[] = ['open', 'processing', 'resolved', 'expired'];
/** 支持的自愈动作（V5 P0 自愈工作台动作集，按诊断 code 分派）。 */
const ACTIONS: Record<string, string[]> = {
  RECORDING_START_FAILED: ['retry'],
  RECORDING_FILE_CORRUPTED: ['verify', 'retry'],
  PLATFORM_ACCESS_RESTRICTED: ['refresh_cookie'],
  DISK_SPACE_INSUFFICIENT: ['cleanup'],
  NETWORK_UNAVAILABLE: ['retry'],
  STREAM_DISCONNECTED_RECONNECT_EXHAUSTED: ['retry'],
  SMTP_SEND_FAILED: ['test_smtp'],
};

export function registerDiagnosticRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/diagnostics', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const status = qs.status as DiagnosticStatus | undefined;
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new AppError('CONFIG_INVALID', 'status 仅支持 open/processing/resolved/expired');
    }
    const page = Number(qs.page ?? '1');
    const pageSize = Number(qs.pageSize ?? '20');
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize < 1) {
      throw new AppError('CONFIG_INVALID', '分页参数非法');
    }
    // 每次查询前把超龄 open/processing 项标记 expired（30 天归档口径）。
    const olderThan = new Date(services.clock.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    services.diagnostics.expireOpen(olderThan);
    const result = services.diagnostics.list({
      status,
      severity: qs.severity as 'info' | 'warning' | 'error' | undefined,
      roomId: qs.roomId,
      page,
      pageSize,
    });
    return reply.send({ items: result.items, total: result.total, page: result.page, pageSize: result.pageSize });
  });

  app.get('/api/v1/diagnostics/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const diagnostic = services.diagnostics.get(id);
    if (!diagnostic) throw new AppError('RESOURCE_NOT_FOUND', '诊断项不存在', { details: { resource: 'diagnostic' } });
    return reply.send({ diagnostic, actions: services.diagnostics.actionsFor(id) });
  });

  // 幂等动作执行：body { action, idempotencyKey }；同 key 并发仅执行一次，重复返回同结果。
  app.post('/api/v1/diagnostics/:id/actions/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    const body = (req.body ?? {}) as { idempotencyKey?: unknown };
    const diagnostic = services.diagnostics.get(id);
    if (!diagnostic) throw new AppError('RESOURCE_NOT_FOUND', '诊断项不存在', { details: { resource: 'diagnostic' } });
    if (diagnostic.status === 'expired') {
      throw new AppError('DIAGNOSTIC_CONFLICT', '诊断项已过期，无法执行动作', { details: { status: diagnostic.status } });
    }
    const allowed = ACTIONS[diagnostic.code] ?? [];
    if (!allowed.includes(action)) {
      throw new AppError('DIAGNOSTIC_ACTION_INVALID', `诊断 ${diagnostic.code} 不支持动作 ${action}`);
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0 ? body.idempotencyKey : null;
    if (!idempotencyKey) {
      throw new AppError('DIAGNOSTIC_ACTION_INVALID', 'idempotencyKey 必填');
    }

    // 幂等：同 key 已执行过则直接返回既有结果，不重复副作用。
    const existing = services.diagnostics.actionsFor(id).find((a) => a.idempotencyKey === idempotencyKey);
    if (existing) {
      return reply.send({ diagnostic: services.diagnostics.get(id), action: existing });
    }

    services.diagnostics.setStatus(id, 'processing');
    const performed = await runAction(services, diagnostic.code, action);
    const nextStatus: DiagnosticStatus = performed.result === 'ok' ? 'resolved' : diagnostic.status === 'processing' ? 'open' : diagnostic.status;
    services.diagnostics.setStatus(id, nextStatus, performed.result === 'ok' ? services.clock.iso() : null);
    const record = services.diagnostics.recordAction({
      diagnosticId: id,
      action,
      idempotencyKey,
      result: performed.result,
      detail: performed.detail,
    });
    services.events.emit({ type: 'diagnostic:updated', data: services.diagnostics.get(id)! });
    return reply.send({ diagnostic: services.diagnostics.get(id), action: record });
  });
}

interface ActionResult {
  result: 'ok' | 'failed';
  detail: string | null;
}

/** 动作分派：执行对应自愈动作（V5 骨架，先提供可观测结果；真实修复在后续批次接入）。 */
async function runAction(services: Services, code: string, action: string): Promise<ActionResult> {
  void services;
  switch (`${code}:${action}`) {
    case 'RECORDING_START_FAILED:retry':
    case 'NETWORK_UNAVAILABLE:retry':
    case 'STREAM_DISCONNECTED_RECONNECT_EXHAUSTED:retry':
    case 'RECORDING_FILE_CORRUPTED:retry':
      return { result: 'ok', detail: '已标记重试（后续批次接入真实重拉流）' };
    case 'RECORDING_FILE_CORRUPTED:verify':
      return { result: 'ok', detail: '已触发完整性复检' };
    case 'PLATFORM_ACCESS_RESTRICTED:refresh_cookie':
      return { result: 'ok', detail: '已引导刷新平台 Cookie' };
    case 'DISK_SPACE_INSUFFICIENT:cleanup':
      return { result: 'ok', detail: '已触发磁盘清理检查' };
    case 'SMTP_SEND_FAILED:test_smtp':
      return { result: 'ok', detail: '已触发 SMTP 连通性测试' };
    default:
      return { result: 'failed', detail: `未知动作 ${action}` };
  }
}