import { useEffect, useRef, useState } from "react";
import { Button, Input, Select, Slider, Space } from "antd";
import { useSettingsModelContext } from "../model/SettingsContext";
import { OrdinaryRow, SettingControl, SettingsRow } from "./SettingsPrimitives";
import MemphisRadioGroup from "../../../components/MemphisRadioGroup";
import DirectoryPicker from "../../../components/DirectoryPicker";
import DetectionLoadHint from "../../../components/DetectionLoadHint";
import type { ThemePreference } from "../../../types/settings";
import { useAppTheme } from "../../../theme";
import {
  NAMING_PRESETS,
  NAMING_VARS,
  previewNamingRule,
} from "../../../api/naming";
import { validateDirectory } from "../../../api/settings";
import PipelineFlow from "./PipelineFlow";

export function AppearancePanel() {
  const model = useSettingsModelContext();
  const { setPreference } = useAppTheme();
  const theme = model.value("theme") as ThemePreference | undefined;
  useEffect(() => {
    const confirmed = model.models.settings?.theme as
      ThemePreference | undefined;
    if (confirmed) setPreference(confirmed);
  }, [model.models.settings?.theme, setPreference]);
  return (
    <>
      <SettingsRow id="theme">
        <MemphisRadioGroup
          disabled={!model.loaded("theme")}
          aria-labelledby="theme-label"
          value={theme}
          options={[
            { value: "light", label: "浅色" },
            { value: "dark", label: "深色" },
            { value: "system", label: "跟随系统" },
          ]}
          onChange={(e) => model.change("theme", e.target.value)}
        />
      </SettingsRow>
      <OrdinaryRow id="global-search" />
      <OrdinaryRow id="statusbar-alerts" />
      <OrdinaryRow id="live-room-cover" />
      <SettingsRow id="recorder-size">
        <div className="lr-settings-slider">
          <Slider
            id="recorder-size-control"
            ariaLabelForHandle="全局录制按钮大小"
            min={20}
            max={100}
            value={Number(model.value("recorder-size") ?? 36)}
            disabled={!model.loaded("recorder-size")}
            onChange={(v) =>
              model.change("recorder-size", v, 0, "recorder-size")
            }
            onChangeComplete={(v) => model.change("recorder-size", v)}
          />
          <output>{String(model.value("recorder-size") ?? 36)} px</output>
        </div>
      </SettingsRow>
    </>
  );
}
export function RecordingPanel() {
  return (
    <>
      {[
        "quality",
        "concurrency",
        "auto-record",
        "danmaku",
        "prevent-sleep",
        "confirm-complete",
      ].map((id) => (
        <OrdinaryRow key={id} id={id} />
      ))}
    </>
  );
}
export function MonitoringPanel() {
  return (
    <>
      <p>按平台设置检查开播状态的间隔（秒），数值越小响应越快。</p>
      {["default", "bilibili", "douyin", "xiaohongshu", "youtube"].map((p) => (
        <OrdinaryRow key={p} id={`interval-${p}`} />
      ))}
      <DetectionLoadHint />
    </>
  );
}
export function DirectoryRow({
  id,
}: {
  id: "recording-directory" | "archive-directory";
}) {
  const model = useSettingsModelContext();
  const [open, setOpen] = useState(false);
  const directory = String(model.value(id) ?? "");
  const request = useRef(0);
  const [validation, setValidation] = useState<{
    path: string;
    checking?: boolean;
    ok?: boolean;
    error?: string;
  } | null>(null);
  const disabled =
    !model.loaded(id) ||
    (id === "archive-directory" && model.value("pipeline-enabled") !== true);
  const changeDirectory = (path: string, immediate = false) => {
    request.current++;
    setValidation(null);
    if (model.states[id]?.phase === "error") model.queue.discard(id);
    model.change(id, path, immediate ? 0 : 500);
  };
  const checkDirectory = async () => {
    const token = ++request.current;
    const path = directory;
    setValidation({ path, checking: true });
    try {
      if (!path.trim()) throw new Error("请选择保存目录");
      if (!(await validateDirectory(path)).ok) throw new Error("目录不可用");
      if (token === request.current) setValidation({ path, ok: true });
    } catch (e) {
      if (token === request.current)
        setValidation({
          path,
          ok: false,
          error: e instanceof Error ? e.message : "目录校验失败",
        });
    }
  };
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const result = validation?.path === directory ? validation : null;
  const automaticallyValidated =
    !!directory.trim() &&
    model.states[id]?.phase === "saved" &&
    directory ===
      (id === "recording-directory"
        ? model.models.settings?.recordingDirectory
        : model.models.pipeline?.archiveDirectory);
  return (
    <SettingsRow id={id} wide>
      <Space.Compact className="lr-settings-directory-editor">
        <Input
          id={`${id}-control`}
          aria-labelledby={`${id}-label`}
          value={directory}
          disabled={disabled}
          onChange={(e) => changeDirectory(e.target.value)}
          onBlur={() => void checkDirectory()}
        />
        <Button disabled={disabled} onClick={() => setOpen(true)}>
          浏览…
        </Button>
        <Button
          disabled={disabled}
          loading={result?.checking === true}
          onClick={() => void checkDirectory()}
        >
          校验
        </Button>
      </Space.Compact>
      {result?.checking ? (
        <p role="status" className="lr-settings-note">
          正在校验目录…
        </p>
      ) : result?.error ? (
        <p role="alert" className="lr-settings-directory-error">
          {result.error}
        </p>
      ) : result?.ok || automaticallyValidated ? (
        <p role="status" className="lr-settings-note">
          目录可用
        </p>
      ) : null}
      <DirectoryPicker
        open={open}
        initialPath={directory || undefined}
        onClose={() => setOpen(false)}
        onPick={(path) => {
          changeDirectory(path, true);
          setOpen(false);
        }}
      />
    </SettingsRow>
  );
}

export function NamingPanel() {
  const model = useSettingsModelContext();
  const rule = String(model.value("naming-rule") ?? "");
  const [preview, setPreview] = useState({ rule: "", example: "", error: "" });
  const example = preview.rule === rule ? preview.example : "";
  const error = preview.rule === rule ? preview.error : "";
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!rule.trim()) return;
      void previewNamingRule(rule)
        .then((example) => {
          if (!cancelled) setPreview({ rule, example, error: "" });
        })
        .catch((e) => {
          if (!cancelled)
            setPreview({
              rule,
              example: "",
              error: e instanceof Error ? e.message : "预览失败",
            });
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      cancelled = true;
    };
  }, [rule]);
  return (
    <SettingsRow id="naming-rule" wide>
      <div className="lr-settings-naming-editor">
        <Select
          aria-label="命名规则预设"
          placeholder="选择预设模板"
          value={model.loaded("naming-rule") ? rule : undefined}
          labelRender={() =>
            NAMING_PRESETS.find((p) => p.value === rule)?.label ?? "自定义"
          }
          options={NAMING_PRESETS}
          onChange={(v) => model.change("naming-rule", v)}
        />
        <SettingControl id="naming-rule" />
      </div>
      <div className="lr-settings-vars">
        <span>插入变量：</span>
        {NAMING_VARS.map((v) => (
          <Button
            key={v}
            size="small"
            onClick={() => model.change("naming-rule", `${rule}{${v}}`, 500)}
          >{`{${v}}`}</Button>
        ))}
      </div>
      <p className="lr-settings-example">
        示例：<code>{example || "等待输入"}</code>
      </p>
      {error && <p role="alert">{error}</p>}
    </SettingsRow>
  );
}
export function PipelinePanel() {
  return (
    <PipelineFlow archiveEditor={<DirectoryRow id="archive-directory" />} />
  );
}
