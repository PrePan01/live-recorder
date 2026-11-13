import type { DB } from "../connection.js";
import {
  foldKeywordCase,
  type KeywordPlan,
  type KeywordPlanInput,
} from "../../core/keyword-plan.js";
import { newId, nowIso } from "../../utils/id.js";

interface KeywordPlanRow {
  id: string;
  room_id: string;
  enabled: number;
  include_keywords: string;
  exclude_keywords: string;
  created_at: string;
  updated_at: string;
}

function rowToPlan(row: KeywordPlanRow): KeywordPlan {
  return {
    id: row.id,
    roomId: row.room_id,
    enabled: row.enabled === 1,
    includeKeywords: JSON.parse(row.include_keywords) as string[],
    excludeKeywords: JSON.parse(row.exclude_keywords) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type KeywordRule = Pick<
  KeywordPlanInput,
  "includeKeywords" | "excludeKeywords"
>;

export class KeywordPlanRepository {
  private readonly enabledByRoom = new Map<string, Map<string, KeywordRule>>();

  constructor(private db: DB) {
    const rows = db
      .prepare("SELECT * FROM recording_keyword_plans WHERE enabled = 1")
      .all() as KeywordPlanRow[];
    for (const row of rows) this.index(rowToPlan(row));
  }

  private index(plan: KeywordPlan): void {
    if (!plan.enabled) {
      this.unindex(plan.roomId, plan.id);
      return;
    }
    const rules =
      this.enabledByRoom.get(plan.roomId) ?? new Map<string, KeywordRule>();
    rules.set(plan.id, {
      includeKeywords: plan.includeKeywords.map(foldKeywordCase),
      excludeKeywords: plan.excludeKeywords.map(foldKeywordCase),
    });
    this.enabledByRoom.set(plan.roomId, rules);
  }

  private unindex(roomId: string, id: string): void {
    const rules = this.enabledByRoom.get(roomId);
    if (!rules) return;
    rules.delete(id);
    if (!rules.size) this.forgetRoom(roomId);
  }

  forgetRoom(roomId: string): void {
    this.enabledByRoom.delete(roomId);
  }

  clearIndex(): void {
    this.enabledByRoom.clear();
  }

  hasEnabledForRoom(roomId: string): boolean {
    return this.enabledByRoom.has(roomId);
  }

  matches(roomId: string, title: string | undefined): boolean {
    const rules = this.enabledByRoom.get(roomId);
    if (!rules || !title?.trim()) return false;
    const folded = foldKeywordCase(title);
    for (const { includeKeywords, excludeKeywords } of rules.values()) {
      if (
        (!includeKeywords.length ||
          includeKeywords.some((word) => folded.includes(word))) &&
        !excludeKeywords.some((word) => folded.includes(word))
      )
        return true;
    }
    return false;
  }

  listForRoom(roomId: string): KeywordPlan[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM recording_keyword_plans
      WHERE room_id = ? ORDER BY created_at, id`,
      )
      .all(roomId) as KeywordPlanRow[];
    return rows.map(rowToPlan);
  }

  get(roomId: string, id: string): KeywordPlan | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM recording_keyword_plans WHERE room_id = ? AND id = ?",
      )
      .get(roomId, id) as KeywordPlanRow | undefined;
    return row && rowToPlan(row);
  }

  create(roomId: string, input: KeywordPlanInput): KeywordPlan {
    const now = nowIso();
    const plan = {
      ...input,
      roomId,
      id: newId("kwp"),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO recording_keyword_plans
      (id, room_id, enabled, include_keywords, exclude_keywords, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        roomId,
        Number(input.enabled),
        JSON.stringify(input.includeKeywords),
        JSON.stringify(input.excludeKeywords),
        now,
        now,
      );
    this.index(plan);
    return plan;
  }

  update(existing: KeywordPlan, input: KeywordPlanInput): KeywordPlan {
    const plan = { ...existing, ...input, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE recording_keyword_plans
      SET enabled = ?, include_keywords = ?, exclude_keywords = ?, updated_at = ?
      WHERE room_id = ? AND id = ?`,
      )
      .run(
        Number(plan.enabled),
        JSON.stringify(plan.includeKeywords),
        JSON.stringify(plan.excludeKeywords),
        plan.updatedAt,
        plan.roomId,
        plan.id,
      );
    this.index(plan);
    return plan;
  }

  remove(roomId: string, id: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM recording_keyword_plans WHERE room_id = ? AND id = ?",
      )
      .run(roomId, id);
    this.unindex(roomId, id);
    return result.changes > 0;
  }
}
