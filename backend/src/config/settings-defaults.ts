import { DEFAULT_SETTINGS } from "./defaults.js";
import {
  DEFAULT_NAMING_RULE,
  DEFAULT_NOTIFICATION_PREFERENCE,
  DEFAULT_PIPELINE_CONFIG,
} from "../types/settings.js";

/** Only ordinary, restorable preferences. Paths and credentials never belong here. */
export function settingsDefaults() {
  const {
    recordingDirectory: _directory,
    retry: _retry,
    diskGuard: _disk,
    mail: _mail,
    pipeline: _pipeline,
    notifications: _notifications,
    namingRule: _naming,
    recordingFormat: _format,
    dedupeWindowMinutes: _dedupe,
    ...settings
  } = DEFAULT_SETTINGS;
  const {
    archiveDirectory: _archive,
    maxConcurrency: _concurrency,
    ...pipeline
  } = DEFAULT_PIPELINE_CONFIG;
  return structuredClone({
    settings: {
      ...settings,
      encodingMode: "auto" as const,
      danmaku: { enabled: false },
    },
    pipeline,
    notifications: {
      ...DEFAULT_NOTIFICATION_PREFERENCE,
      desktop: {
        ...DEFAULT_NOTIFICATION_PREFERENCE.desktop,
        pipelineCompleted: false,
        pipelineFailed: false,
      },
      email: {
        ...DEFAULT_NOTIFICATION_PREFERENCE.email,
        pipelineCompleted: false,
        pipelineFailed: false,
      },
    },
    naming: { namingRule: DEFAULT_NAMING_RULE },
    openlist: { enabled: false, deleteSourceAfterUpload: false },
    email: { enabled: false },
    qmsg: { enabled: false },
  });
}
