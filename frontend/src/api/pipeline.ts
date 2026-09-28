import { http, API_BASE } from "./client";
import type {
  PipelineConfig,
  PipelineRun,
  PipelineRunDetail,
} from "../types/pipeline";

export async function fetchPipelineConfig(): Promise<PipelineConfig> {
  const { data } = await http.get<{ pipeline: PipelineConfig }>(
    "/settings/pipeline",
  );
  return data.pipeline;
}

export async function updatePipelineConfig(
  input: Partial<PipelineConfig>,
): Promise<PipelineConfig> {
  const { data } = await http.put<{ pipeline: PipelineConfig }>(
    "/settings/pipeline",
    input,
  );
  return data.pipeline;
}

export async function fetchPipelineRun(
  recordingId: string,
): Promise<PipelineRunDetail> {
  const { data } = await http.get<{ run: PipelineRun | null }>(
    `/recordings/${recordingId}/pipeline`,
  );
  if (!data.run) return { run: null, artifacts: [] };
  const { artifacts, ...rest } = data.run;
  return { run: rest, artifacts };
}

export async function startPipeline(
  recordingId: string,
): Promise<PipelineRunDetail> {
  const { data } = await http.post<{ ok: boolean; run: PipelineRun | null }>(
    `/recordings/${recordingId}/pipeline/start`,
  );
  if (!data.run) return { run: null, artifacts: [] };
  const { artifacts, ...rest } = data.run;
  return { run: rest, artifacts };
}

export async function retryPipeline(
  recordingId: string,
): Promise<PipelineRunDetail> {
  const { data } = await http.post<{ ok: boolean; run: PipelineRun | null }>(
    `/recordings/${recordingId}/pipeline/retry`,
  );
  if (!data.run) return { run: null, artifacts: [] };
  const { artifacts, ...rest } = data.run;
  return { run: rest, artifacts };
}

export async function openPipelineArtifact(
  recordingId: string,
  artifactId: string,
  target: "file" | "directory",
): Promise<void> {
  await http.post(
    `/recordings/${recordingId}/pipeline/artifacts/${artifactId}/open`,
    { target },
  );
}

export function coverUrl(recordingId: string): string {
  return `${API_BASE}/media/cover/${recordingId}`;
}
