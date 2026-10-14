import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  fetchSettings,
  fetchSettingsDefaults,
  updateSettings,
  validateDirectory,
} from "../../../api/settings";
import type { SettingsInput } from "../../../types/settings";
import {
  fetchPipelineConfig,
  updatePipelineConfig,
} from "../../../api/pipeline";
import { fetchEmail, updateEmail } from "../../../api/email";
import {
  fetchOpenListConfig,
  updateOpenListConfig,
  testOpenList,
} from "../../../api/openlist";
import { fetchNamingRule, updateNamingRule } from "../../../api/naming";
import {
  fetchNotifications,
  updateNotifications,
} from "../../../api/notification";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useAppearanceStore } from "../../../stores/appearanceStore";
import {
  BY_ID,
  getPath,
  pathPatch,
  validateValue,
  type Domain,
} from "./catalog";
import {
  acknowledgeDrafts,
  mergePatch,
  SettingsSaveQueue,
  type Patch,
} from "./saveQueue";
import { OpenListConnection, type ConnectionState } from "./openListConnection";

const UPLOAD_CREDENTIALS = ["upload-serverUrl", "upload-username", "upload-token"];

type Models = Partial<Record<Domain, Patch>>;
function asPatch(value: unknown): Patch {
  return value as Patch;
}
export function useSettingsModel() {
  const [queue] = useState(() => new SettingsSaveQueue());
  const states = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [models, setModels] = useState<Models>(() => {
    const settings = useSettingsStore.getState().settings;
    return {
      appearance: {
        showGlobalSearch: useAppearanceStore.getState().showGlobalSearch,
        showStatusBarAlerts: useAppearanceStore.getState().showStatusBarAlerts,
        showLiveRoomCover: useAppearanceStore.getState().showLiveRoomCover,
      },
      ...(settings
        ? {
            settings: asPatch(settings),
            email: asPatch(settings.mail),
            ...(settings.pipeline
              ? { pipeline: asPatch(settings.pipeline) }
              : {}),
            ...(settings.notifications
              ? { notifications: asPatch(settings.notifications) }
              : {}),
            ...(settings.namingRule
              ? { naming: { namingRule: settings.namingRule } }
              : {}),
          }
        : {}),
    };
  });
  const [defaults, setDefaults] = useState<Models>();
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [connection, setConnection] = useState<ConnectionState>({ phase: "unchecked", message: "连接尚未检测" });
  const drafts = useRef<Patch>({});
  const [draftVersion, setDraftVersion] = useState(0);
  const dirty = useCallback(() => setDraftVersion((v) => v + 1), []);
  const connectionOperations = useMemo(() => ({
    test: testOpenList,
    status: setConnection,
    writeEnabled: async (enabled: boolean) => {
      const saved = await updateOpenListConfig({ enabled });
      setModels((m) => ({ ...m, openlist: asPatch(saved) }));
      drafts.current = acknowledgeDrafts(drafts.current, { "upload-enabled": enabled });
      dirty();
    },
    rejectedEnable: () => {
      delete drafts.current["upload-enabled"];
      queue.discard("upload-enabled");
      dirty();
    },
  }), [queue, dirty]);
  const [uploadConnection] = useState(() => new OpenListConnection(queue));
  useEffect(() => uploadConnection.configure(connectionOperations), [uploadConnection, connectionOperations]);
  const reload = useCallback(async () => {
    const loaders: Array<[Domain, () => Promise<unknown>]> = [
      ["settings", fetchSettings],
      ["pipeline", fetchPipelineConfig],
      ["email", fetchEmail],
      ["openlist", fetchOpenListConfig],
      ["naming", async () => ({ namingRule: await fetchNamingRule() })],
      ["notifications", fetchNotifications],
    ];
    await Promise.all(
      loaders.map(async ([domain, loader]) => {
        try {
          const data = await loader();
          setModels((m) => ({ ...m, [domain]: asPatch(data) }));
          setLoadErrors((e) => {
            const n = { ...e };
            delete n[domain];
            return n;
          });
        } catch (error) {
          setLoadErrors((e) => ({
            ...e,
            [domain]: error instanceof Error ? error.message : "加载失败",
          }));
        }
      }),
    );
  }, []);
  const reloadDefaults = useCallback(
    () =>
      fetchSettingsDefaults()
        .then((data) => {
          setDefaults(data as unknown as Models);
          setLoadErrors((e) => {
            const n = { ...e };
            delete n.defaults;
            return n;
          });
        })
        .catch(() => {
          setLoadErrors((e) => ({
            ...e,
            defaults: "默认值加载失败，比较与恢复暂不可用",
          }));
        }),
    [],
  );
  useEffect(() => {
    void reload();
    void reloadDefaults();
  }, [reload, reloadDefaults]);
  useEffect(
    () =>
      useSettingsStore.subscribe((next, previous) => {
        const settings = next.settings;
        if (!settings || settings === previous.settings) return;
        setModels((m) => ({
          ...m,
          settings: asPatch(settings),
          email: asPatch(settings.mail),
          ...(settings.pipeline
            ? { pipeline: asPatch(settings.pipeline) }
            : {}),
          ...(settings.namingRule
            ? { naming: { namingRule: settings.namingRule } }
            : {}),
          ...(settings.notifications
            ? { notifications: asPatch(settings.notifications) }
            : {}),
        }));
      }),
    [],
  );
  useEffect(
    () =>
      useAppearanceStore.subscribe((state) => {
        setModels((m) => ({
          ...m,
          appearance: {
            showGlobalSearch: state.showGlobalSearch,
            showStatusBarAlerts: state.showStatusBarAlerts,
            showLiveRoomCover: state.showLiveRoomCover,
          },
        }));
      }),
    [],
  );
  // Timers are flushed by the navigation blocker before unmounting.
  useEffect(() => () => { uploadConnection.invalidate(); queue.dispose(); }, [queue, uploadConnection]);
  const value = (id: string): unknown =>
    id in drafts.current
      ? drafts.current[id]
      : BY_ID[id]!.secret
        ? ""
        : (getPath(models[BY_ID[id]!.domain], BY_ID[id]!.path) ??
          getPath(defaults?.[BY_ID[id]!.domain], BY_ID[id]!.path));
  const defaultValue = (id: string) =>
    BY_ID[id]?.domain === "appearance"
      ? id === "live-room-cover"
      : getPath(defaults?.[BY_ID[id]!.domain], BY_ID[id]!.path);
  const isModified = (id: string) =>
    !!defaults &&
    !!BY_ID[id]?.restorable &&
    defaultValue(id) !== undefined &&
    JSON.stringify(value(id)) !== JSON.stringify(defaultValue(id));
  const execute = async (patch: Patch) => {
    const ids = Object.keys(patch);
    const domain = BY_ID[ids[0]!]!.domain;
    let payload: Patch = {};
    for (const id of ids)
      payload = mergePatch(payload, pathPatch(BY_ID[id]!.path, patch[id]));
    if (domain === "email" && typeof payload.recipients === "string") {
      payload.recipients = payload.recipients
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }
    let saved: Patch;
    if (domain === "settings") {
      if ("recordingDirectory" in payload)
        await validateDirectory(String(payload.recordingDirectory));
      const data = await updateSettings(payload as SettingsInput);
      useSettingsStore.getState().setSettings(data);
      saved = asPatch(data);
    } else if (domain === "pipeline") {
      if (payload.archiveDirectory)
        await validateDirectory(String(payload.archiveDirectory));
      saved = asPatch(await updatePipelineConfig(payload));
    } else if (domain === "notifications")
      saved = asPatch(await updateNotifications(payload));
    else if (domain === "naming")
      saved = {
        namingRule: await updateNamingRule(String(payload.namingRule)),
      };
    else if (domain === "email") saved = asPatch(await updateEmail(payload));
    else if (domain === "openlist") {
      saved = asPatch(await updateOpenListConfig(payload));
    } else {
      const appearance = useAppearanceStore.getState();
      if ("showGlobalSearch" in payload)
        appearance.setShowGlobalSearch(Boolean(payload.showGlobalSearch));
      if ("showStatusBarAlerts" in payload)
        appearance.setShowStatusBarAlerts(Boolean(payload.showStatusBarAlerts));
      if ("showLiveRoomCover" in payload)
        appearance.setShowLiveRoomCover(Boolean(payload.showLiveRoomCover));
      const current = useAppearanceStore.getState();
      saved = {
        showGlobalSearch: current.showGlobalSearch,
        showStatusBarAlerts: current.showStatusBarAlerts,
        showLiveRoomCover: current.showLiveRoomCover,
      };
    }
    setModels((m) => ({ ...m, [domain]: saved }));
    drafts.current = acknowledgeDrafts(drafts.current, patch);
    dirty();
    if (domain === "openlist" && saved.enabled &&
      ["serverUrl", "username", "token"].some((key) => key in payload) &&
      !UPLOAD_CREDENTIALS.some((id) => id in drafts.current) &&
      drafts.current["upload-enabled"] !== false) {
      void uploadConnection.verify("revalidate");
    }
  };
  const change = (
    id: string,
    next: unknown,
    delay = 0,
    manualGroup?: string,
  ) => {
    if (
      (id === "email-password" || id === "upload-token") &&
      !String(next ?? "").length
    ) {
      queue.discard(id);
      delete drafts.current[id];
      dirty();
      return;
    }
    if (UPLOAD_CREDENTIALS.includes(id) || id === "upload-enabled") {
      uploadConnection.invalidate();
      if (UPLOAD_CREDENTIALS.includes(id) && drafts.current["upload-enabled"] === true) {
        delete drafts.current["upload-enabled"];
        queue.discard("upload-enabled");
      }
      setConnection({ phase: "unchecked", message: "连接尚未检测" });
    }
    drafts.current[id] = next;
    dirty();
    const error = validateValue(BY_ID[id]!, next);
    if (manualGroup) {
      queue.stage(manualGroup, error);
      return;
    }
    if (error) {
      queue.stage(id, error);
      return;
    }
    if (id === "upload-enabled" && next === true) {
      queue.stage(id);
      void uploadConnection.verify("enable", () => queue.flush(UPLOAD_CREDENTIALS));
      return;
    }
    if (id === "upload-enabled") queue.discard(id);
    queue.enqueue(id, { [id]: next }, execute, delay);
  };
  const submit = (group: string, ids: string[], error?: string) => {
    if (error) {
      queue.stage(group, error);
      return;
    }
    ids
      .filter(
        (id) => BY_ID[id]!.secret && !String(drafts.current[id] ?? "").length,
      )
      .forEach((id) => delete drafts.current[id]);
    dirty();
    const patch = Object.fromEntries(
      ids
        .filter(
          (id) =>
            id in drafts.current &&
            (!BY_ID[id]!.secret || String(drafts.current[id] ?? "").length > 0),
        )
        .map((id) => [id, drafts.current[id]]),
    );
    if (Object.keys(patch).length) queue.enqueue(group, patch, execute);
    else {
      ids.forEach((id) => delete drafts.current[id]);
      queue.discard(group);
      dirty();
    }
  };
  const discard = (group: string, ids: string[] = [group]) => {
    ids.forEach((id) => delete drafts.current[id]);
    queue.discard(group);
    dirty();
  };
  const restore = (id: string) => {
    if (!BY_ID[id]?.restorable || defaultValue(id) === undefined) return;
    queue.discard(id);
    change(id, defaultValue(id));
  };
  const discardAll = async () => {
    uploadConnection.invalidate();
    await queue.flush();
    Object.keys(queue.getSnapshot()).forEach((id) => queue.discard(id));
    drafts.current = {};
    dirty();
  };
  const hasUnsaved = useCallback(() => queue.hasUnsaved() || uploadConnection.hasPendingWrites(), [queue, uploadConnection]);
  const flush = async () => {
    // Leaving/importing waits for consequential probes without blocking ordinary writes.
    let saved: boolean;
    do {
      await queue.flush();
      await uploadConnection.waitForWrites();
      saved = await queue.flush();
    } while (uploadConnection.hasPendingWrites());
    return saved;
  };
  return {
    models,
    connection,
    setConnection,
    testUploadConnection: () => uploadConnection.verify("check"),
    defaults,
    loadErrors,
    reload,
    reloadDefaults,
    value,
    defaultValue,
    restore,
    isModified,
    change,
    submit,
    discard,
    discardAll,
    flush,
    hasUnsaved,
    queue,
    states,
    draftVersion,
    isDraft: (ids: string[]) => ids.some((id) => id in drafts.current),
    loaded: (id: string) => !!models[BY_ID[id]!.domain],
  };
}
