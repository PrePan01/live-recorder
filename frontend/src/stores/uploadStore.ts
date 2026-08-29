import { create } from 'zustand';
import type { UploadJob } from '../api/openlist';

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
      next[idx] = job;
      return { jobs: next };
    });
  },
  setJobs(jobs) {
    set({ jobs });
  },
}));