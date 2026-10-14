import { http } from "./client";
import { useAppearanceStore } from "../stores/appearanceStore";
import type {
  BrowseDirectoriesResult,
  ExportConfig,
  ExportConfigFileResult,
  ImportConfigInput,
  ImportResult,
} from "../types/config";

export async function browseDirectories(
  path?: string,
): Promise<BrowseDirectoriesResult> {
  const { data } = await http.get<BrowseDirectoriesResult>(
    "/settings/browse-directories",
    {
      params: path ? { path } : undefined,
    },
  );
  return data;
}

export async function pickDirectory(): Promise<string | null> {
  const { data } = await http.post<{ ok: boolean; directory: string | null }>(
    "/settings/pick-directory",
    undefined,
    { timeout: 0 },
  );
  return data.directory;
}

export async function exportConfig(): Promise<ExportConfig> {
  const { data } = await http.get<{ config: ExportConfig }>("/config/export");
  return {
    ...data.config,
    appearance: {
      showStatusBarAlerts: useAppearanceStore.getState().showStatusBarAlerts,
      showLiveRoomCover: useAppearanceStore.getState().showLiveRoomCover,
    },
  };
}

export async function exportConfigToFile(): Promise<ExportConfigFileResult> {
  const { data } = await http.post<ExportConfigFileResult>(
    "/config/export-file",
    {
      appearance: {
        showStatusBarAlerts: useAppearanceStore.getState().showStatusBarAlerts,
        showLiveRoomCover: useAppearanceStore.getState().showLiveRoomCover,
      },
    },
    { timeout: 0 },
  );
  return data;
}

export async function importConfig(
  input: ImportConfigInput,
): Promise<ImportResult> {
  const { data } = await http.post<ImportResult>("/config/import", {
    config: input,
  });
  if (data.ok && typeof input.appearance?.showStatusBarAlerts === "boolean") {
    useAppearanceStore
      .getState()
      .setShowStatusBarAlerts(input.appearance.showStatusBarAlerts);
  }
  if (data.ok && typeof input.appearance?.showLiveRoomCover === "boolean") {
    useAppearanceStore
      .getState()
      .setShowLiveRoomCover(input.appearance.showLiveRoomCover);
  }
  return data;
}
