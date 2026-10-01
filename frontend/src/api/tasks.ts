import { http } from "./client";
import type { TaskItem } from "../types/tasks";

/**
 * 任务进度聚合（轻只读）：四类在途任务统一 DTO。
 * 完成即离在途扫描；失败文案沿用既有人话契约（error 字段随行）。
 */
export async function fetchTasks(): Promise<TaskItem[]> {
  const { data } = await http.get<{ tasks: TaskItem[] }>("/tasks");
  return data.tasks ?? [];
}
