import { createHash } from 'node:crypto';
import type { DanmakuAdapter, DanmakuMessage } from '../types.js';
import { XHS_API, type XiaohongshuAdapter } from '../../platform/xiaohongshu.js';

export function createXiaohongshuDanmakuAdapter(adapter: XiaohongshuAdapter): DanmakuAdapter {
  return {
    platform: 'xiaohongshu',
    async *collect(roomUrl, cookie, signal, onConnected): AsyncIterable<DanmakuMessage> {
      const room = await adapter.resolveMediaRoom(roomUrl, cookie ?? undefined, signal);
      if (!room.live || signal.aborted) return;
      let cursor = Date.now(), connected = false;
      const seen = new Set<string>();
      while (!signal.aborted) {
        // The official HTTP client serializes its camelCase options to snake_case on the wire.
        const params = new URLSearchParams({ room_id: room.roomId, start_timestamp: String(cursor), size: '10', need_praise: 'true', need_viewer: 'true' });
        let response;
        try { response = await adapter.request(`${XHS_API}/api/sns/red/live/h5/v1/interaction/get_simple_interaction?${params}`, cookie ?? undefined, signal); }
        catch (error) { if (signal.aborted) return; throw error; }
        let json;
        try { json = JSON.parse(response.text); } catch { throw new Error('小红书弹幕响应格式异常'); }
        if (json.success !== true || !Array.isArray(json.data?.comments)) throw new Error('小红书弹幕访问受限，请重新授权后重试');
        if (!connected) { connected = true; onConnected?.(); }
        const data = json.data;
        const now = Date.now();
        for (const [index, comment] of data.comments.entries()) {
          if (typeof comment?.desc !== 'string' || !comment.desc || Buffer.byteLength(comment.desc) > 16000) continue;
          const key = String(comment.id ?? comment.comment_id ?? comment.commentId ?? createHash('sha256').update(JSON.stringify([
            room.roomId, comment.timestamp ?? comment.create_time ?? comment.createTime ?? cursor, comment.profile?.user_id ?? comment.profile?.userId, comment.desc, index,
          ])).digest('hex'));
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > 4096) seen.delete(seen.values().next().value!);
          yield { id: `xiaohongshu:${room.roomId}:${key}`, tMs: null, wallMs: now, text: comment.desc };
        }
        const end = Number(data.end_timestamp ?? data.endTimestamp);
        if (Number.isSafeInteger(end) && end >= cursor) cursor = end;
        const interval = Math.min(60000, Math.max(1000, Number(data.next_request_interval ?? data.nextRequestInterval) || 5000));
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, interval);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      }
    },
  };
}
