import type { DB } from '../connection.js';
import type { Tag } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

interface TagRow {
  id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

function rowToTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TagRepository {
  constructor(private db: DB) {}

  list(): Tag[] {
    const rows = this.db.prepare('SELECT * FROM tags ORDER BY name COLLATE NOCASE ASC').all() as TagRow[];
    return rows.map(rowToTag);
  }

  get(id: string): Tag | null {
    const row = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined;
    return row ? rowToTag(row) : null;
  }

  findByName(name: string): Tag | null {
    const row = this.db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(name) as TagRow | undefined;
    return row ? rowToTag(row) : null;
  }

  create(input: { name: string; color: string }): Tag {
    const now = nowIso();
    const tag: Tag = { id: newId('tag'), name: input.name, color: input.color, createdAt: now, updatedAt: now };
    try {
      this.db
        .prepare('INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(tag.id, tag.name, tag.color, now, now);
    } catch (err) {
      if (String((err as { message?: string }).message ?? '').includes('UNIQUE constraint failed: tags.name')) {
        throw new Error('TAG_NAME_DUPLICATE');
      }
      throw err;
    }
    return tag;
  }

  update(id: string, patch: { name?: string; color?: string }): Tag {
    const existing = this.get(id);
    if (!existing) throw new Error('TAG_NOT_FOUND');
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.color !== undefined) {
      sets.push('color = ?');
      params.push(patch.color);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(nowIso());
      try {
        this.db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      } catch (err) {
        if (String((err as { message?: string }).message ?? '').includes('UNIQUE constraint failed: tags.name')) {
          throw new Error('TAG_NAME_DUPLICATE');
        }
        throw err;
      }
    }
    return this.get(id)!;
  }

  /** 删除标签：只删标签与关联（room_tags 级联），不影响房间与录制。 */
  remove(id: string): void {
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }

  /** 房间关联的标签（按标签名排序，稳定输出）。 */
  tagsForRoom(roomId: string): Tag[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tags t JOIN room_tags rt ON rt.tag_id = t.id
         WHERE rt.room_id = ? ORDER BY t.name COLLATE NOCASE ASC`,
      )
      .all(roomId) as TagRow[];
    return rows.map(rowToTag);
  }

  /** 覆盖式设置房间标签：删除旧关联后写入新关联（去重由 PRIMARY KEY 保证）。 */
  setRoomTags(roomId: string, tagIds: string[]): Tag[] {
    const uniq = [...new Set(tagIds)];
    for (const tagId of uniq) {
      if (!this.get(tagId)) throw new Error('TAG_NOT_FOUND');
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM room_tags WHERE room_id = ?').run(roomId);
      for (const tagId of uniq) {
        this.db.prepare('INSERT INTO room_tags (room_id, tag_id) VALUES (?, ?)').run(roomId, tagId);
      }
    })();
    return this.tagsForRoom(roomId);
  }

  /** 房间过滤（搜索/统计）：命中任一 tagId 的房间 id 集合。 */
  roomIdsForTags(tagIds: string[]): Set<string> {
    if (tagIds.length === 0) return new Set();
    const placeholders = tagIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT DISTINCT room_id FROM room_tags WHERE tag_id IN (${placeholders})`)
      .all(...tagIds) as { room_id: string }[];
    return new Set(rows.map((r) => r.room_id));
  }
}