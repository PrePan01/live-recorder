import { http } from "./client";
import type { TaskItem } from "../types/tasks";

export async function fetchTasks(
  observedIds: string[] = [],
): Promise<TaskItem[]> {
  const { data } = await http.get<{ tasks: TaskItem[] }>(
    "/tasks",
    observedIds.length ? { params: { ids: observedIds.join(",") } } : undefined,
  );
  return data.tasks ?? [];
}
