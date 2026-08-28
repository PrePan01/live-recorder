import { useEffect, useState } from 'react';
import { formatDuration } from '../utils/format';

export default function RecordingDuration({ startedAt }: { startedAt: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{formatDuration(startedAt)}</span>;
}
