import { create } from 'zustand';
import type { UploadJob } from '../api/openlist';

function latest(current: UploadJob | undefined, incoming: UploadJob): UploadJob {
  if (!current) return incoming;
  return Date.parse(current.updatedAt) > Date.parse(incoming.updatedAt) ? current : incoming;
}

interface UploadState {
  jobs: UploadJob[];
  upsert: (job: UploadJob) => void;
  setJobs: (jobs: UploadJob[]) => void;
}

export const useUploadStore = create<UploadState>((set) => ({
  jobs: [],
  upsert(job) {
    set((s) => {
      const idx = s.jobs.findIndex((x) => x.id === job.id);
      if (idx === -1) return { jobs: [job, ...s.jobs] };
      const next = [...s.jobs];
      next[idx] = latest(next[idx], job);
      return { jobs: next };
    });
  },
  setJobs(jobs) {
    // A list response can race an SSE terminal event. Never erase a newer
    // 2FA failure (or any newer upload state) with that stale snapshot.
    set((state) => {
      const existing = new Map(state.jobs.map((job) => [job.id, job]));
      const merged = jobs.map((job) => latest(existing.get(job.id), job));
      const listed = new Set(jobs.map((job) => job.id));
      return { jobs: [...merged, ...state.jobs.filter((job) => !listed.has(job.id))] };
    });
  },
}));
