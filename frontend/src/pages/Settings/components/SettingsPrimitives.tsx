import { Button, InputNumber, Select, Switch, Input, Popconfirm } from "antd";
import type { ReactNode } from "react";
import { BY_ID, ORIGINAL_HELP } from "../model/catalog";
import { useSettingsModelContext } from "../model/SettingsContext";
export function SaveStatus({ id }: { id?: string }) {
  const { states, queue } = useSettingsModelContext();
  if (id && !states[id]) return null;
  const entries = id ? [states[id]].filter(Boolean) : Object.values(states);
  const state = entries.find(
    (s) => s.phase === "error" || s.phase === "invalid",
  );
  if (!state) return null;
  return (
    <div
      className={`lr-settings-save is-${state.phase}`}
      role="status"
      aria-live="polite"
    >
      <span>{state.phase === "invalid" ? "输入有误" : "保存失败"}</span>
      {state?.error && (
        <span className="lr-settings-save__error">{state.error}</span>
      )}
      {id && state?.phase === "error" && (
        <Button size="small" onClick={() => queue.retry(id)}>
          重试
        </Button>
      )}
    </div>
  );
}
export function SettingsSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="lr-settings-section"
      aria-labelledby={`${id}-heading`}
      data-settings-section
    >
      <header className="lr-settings-section__heading">
        <span className="lr-settings-section__shape" aria-hidden="true" />
        <div>
          <h2 id={`${id}-heading`}>{title}</h2>
        </div>
      </header>
      <div className="lr-settings-section__body">{children}</div>
    </section>
  );
}
export function SettingsGroup({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="lr-settings-group">
      <div className="lr-settings-group__heading">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}
export function SettingsRow({
  id,
  children,
  wide = false,
  anchor = true,
  help = ORIGINAL_HELP[id],
}: {
  id: string;
  children: ReactNode;
  wide?: boolean;
  anchor?: boolean;
  help?: string;
}) {
  const def = BY_ID[id]!;
  return (
    <div
      id={anchor ? id : undefined}
      className={`lr-settings-row${wide ? " is-wide" : ""}`}
    >
      <div className="lr-settings-row__copy">
        <label
          className="lr-settings-row__label"
          id={`${id}-label`}
          htmlFor={`${id}-control`}
        >
          {def.label}
        </label>
        {help && <p className="lr-settings-row__help">{help}</p>}
      </div>
      <div className="lr-settings-row__control">{children}</div>
      <div className="lr-settings-row__status">
        <SaveStatus id={id} />
      </div>
    </div>
  );
}
const OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  theme: [
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
    { value: "system", label: "跟随系统" },
  ],
  quality: [
    { value: "original", label: "原画" },
    ...["1080p", "720p", "540p", "360p"].map((value) => ({
      value,
      label: value,
    })),
  ],
  "encoding-mode": [
    { value: "auto", label: "自动（硬件优先）" },
    { value: "software", label: "仅软件" },
  ],
  "pipeline-format": [
    { value: "source", label: "保留源格式" },
    { value: "mp4", label: "无损转换为 MP4" },
  ],
};
export function SettingControl({
  id,
  manualGroup,
}: {
  id: string;
  manualGroup?: string;
}) {
  const model = useSettingsModelContext();
  const def = BY_ID[id]!;
  const value = model.value(id);
  const dependent =
    def.dependsOn && model.value(def.dependsOn) !== (def.dependsValue ?? true);
  const connectionDraft =
    id === "upload-enabled"
      ? model.isDraft([
          "upload-serverUrl",
          "upload-username",
          "upload-token",
          "upload-directoryTemplate",
        ])
      : id === "email-enabled" && manualGroup
        ? model.isDraft([
            "email-host",
            "email-port",
            "email-secure",
            "email-username",
            "email-from",
            "email-recipients",
            "email-password",
          ])
        : false;
  const disabled =
    !model.loaded(id) ||
    !!dependent ||
    (!!connectionDraft && value !== true) ||
    (id === "upload-enabled" &&
      value !== true &&
      model.connection.phase === "checking") ||
    (id === "pipeline-delete" && model.value("pipeline-enabled") !== true);
  const common = {
    id: `${id}-control`,
    "aria-labelledby": `${id}-label`,
    disabled,
  };
  const change = (next: unknown, delay = 0) =>
    model.change(id, next, delay, manualGroup);
  let control: ReactNode;
  if (OPTIONS[id])
    control = (
      <Select
        {...common}
        value={value as string}
        options={OPTIONS[id]}
        onChange={(v) => change(v)}
      />
    );
  else if (def.min !== undefined)
    control = (
      <div className="lr-settings-number">
        {def.nullable && (
          <Switch
            aria-label="启用压缩"
            disabled={disabled}
            checked={value !== null && value !== undefined}
            onChange={(v) => change(v ? 23 : null)}
          />
        )}
        <InputNumber
          {...common}
          disabled={disabled || (!!def.nullable && value === null)}
          value={value as number | null}
          min={def.min}
          max={def.max}
          onChange={(v) => change(v, 500)}
        />
        <span>{def.unit ?? "CRF"}</span>
      </div>
    );
  else if (
    typeof value === "boolean" ||
    [
      "global-search",
      "statusbar-alerts",
      "live-room-cover",
      "auto-record",
      "danmaku",
      "prevent-sleep",
      "confirm-complete",
      "highlight-enabled",
      "pipeline-verify",
      "pipeline-cover",
      "pipeline-audio",
    ].includes(id) ||
    id.startsWith("notify-") ||
    [
      "secure",
      "enabled",
      "deleteSourceAfterUpload",
      "deleteSourceAfterConvert",
    ].includes(def.path.split(".").at(-1)!)
  ) {
    const switchControl = (
      <Switch
        {...common}
        checked={value === true}
        onChange={(v) => {
          if ((id === "upload-delete" || id === "pipeline-delete") && v) return;
          change(v);
        }}
      />
    );
    control =
      (id === "upload-delete" || id === "pipeline-delete") && !value ? (
        <Popconfirm
          classNames={id === "upload-delete" ? { root: "lr-upload-warning-popconfirm" } : undefined}
          title="确认开启自动删除源文件？"
          description="成功处理后删除的源文件无法撤销。"
          onConfirm={() => change(true)}
        >
          {switchControl}
        </Popconfirm>
      ) : (
        switchControl
      );
  } else if (def.secret)
    control = (
      <Input.Password
        {...common}
        value={typeof value === "string" ? value : ""}
        autoComplete="new-password"
        placeholder="留空将不会修改"
        onChange={(e) => change(e.target.value, manualGroup ? 0 : 500)}
      />
    );
  else
    control = (
      <Input
        {...common}
        value={Array.isArray(value) ? value.join(", ") : String(value ?? "")}
        onChange={(e) => change(e.target.value, manualGroup ? 0 : 500)}
      />
    );
  return control;
}
export function OrdinaryRow({ id }: { id: string }) {
  return (
    <SettingsRow id={id}>
      <SettingControl id={id} />
    </SettingsRow>
  );
}
