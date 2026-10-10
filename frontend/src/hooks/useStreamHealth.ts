import { useEffect } from "react";
import {
  refreshStreamHealth,
  selectStreamHealth,
  useStreamHealthStore,
} from "../stores/streamHealthStore";

export function useStreamHealth(recordingId?: string) {
  const health = useStreamHealthStore((s) =>
    selectStreamHealth(s, recordingId),
  );
  useEffect(() => {
    if (recordingId) void refreshStreamHealth().catch(() => undefined);
  }, [recordingId]);
  return health;
}
