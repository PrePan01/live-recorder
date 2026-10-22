import { useEffect, useRef, useState } from "react";
import {
  App,
  Button,
  Input,
  InputNumber,
  Select,
  Slider,
  Space,
  Tooltip,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { BY_ID, NOTIFICATION_EVENTS } from "../model/catalog";
import { useSettingsModelContext } from "../model/SettingsContext";
import {
  OrdinaryRow,
  SaveStatus,
  SettingControl,
  SettingsGroup,
  SettingsRow,
} from "./SettingsPrimitives";
import MemphisRadioGroup from "../../../components/MemphisRadioGroup";
import DirectoryPicker from "../../../components/DirectoryPicker";
import PlatformAuthorizationList from "../../../components/PlatformAuthorizationList";
import type { Settings, ThemePreference } from "../../../types/settings";
import { useAppTheme } from "../../../theme";
import {
  NAMING_PRESETS,
  NAMING_VARS,
  previewNamingRule,
} from "../../../api/naming";
import {
  fetchEmailPresets,
  testEmail,
  type SmtpPreset,
} from "../../../api/email";
import { validateDirectory } from "../../../api/settings";
import { bridge } from "../../../stores/bootStore";
import PipelineFlow from "./PipelineFlow";
import saveCookieTutorial from "../../../assets/img/save_cookie.png";

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
export function AuthorizationPanel() {
  const model = useSettingsModelContext();
  const { modal } = App.useApp();
  return (
    <PlatformAuthorizationList
      settings={(model.models.settings as unknown as Settings) ?? null}
      onAuthorized={model.reload}
      onClear={(platform) =>
        modal.confirm({
          title: "清除平台授权？",
          content: "清除后需要重新登录",
          onOk: () => {
            model.change(`${platform}-cookie`, "");
          },
        })
      }
      renderSupplement={(config, hasCookie) => (
        <details className="lr-authorization-manual" data-settings-details>
          <summary>手动粘贴 Cookie（高级）</summary>
          <div className="lr-authorization-manual__content">
            <p>
              进入网页版{config.label}并登录，打开任意直播间后按 F12 →
              网络（Network） → 刷新页面 → 点开任意 {config.manualHost} 请求 →
              在「请求标头」复制完整 Cookie 并粘贴。
              {config.platform === "douyin" && (
                <span className="lr-network-help">
                  <Tooltip
                    placement="top"
                    styles={{
                      root: {
                        width: "min(600px, calc(100vw - 48px))",
                        maxWidth: "none",
                      },
                    }}
                    title={
                      <img
                        className="lr-cookie-tutorial-image"
                        src={saveCookieTutorial}
                        alt="从网络面板保存抖音 Cookie 的教程"
                      />
                    }
                  >
                    <Button
                      aria-label="查看抖音网络面板 Cookie 教程"
                      className="lr-inline-icon-button"
                      size="small"
                      type="text"
                      icon={<QuestionCircleOutlined />}
                    />
                  </Tooltip>
                </span>
              )}
            </p>
            {hasCookie && <p>留空不修改现有凭据</p>}
            <label
              className="lr-settings-sr-only"
              id={`${config.anchor}-label`}
              htmlFor={`${config.anchor}-control`}
            >
              {config.label} Cookie
            </label>
            <div className="lr-authorization-credential-editor">
              <SettingControl
                id={config.anchor}
                manualGroup={`${config.anchor}-manual`}
              />

              <Button
                onClick={() =>
                  model.submit(`${config.anchor}-manual`, [config.anchor])
                }
              >
                保存
              </Button>
            </div>
            <SaveStatus id={`${config.anchor}-manual`} />
          </div>
        </details>
      )}
    />
  );
}
export function NotificationPanel() {
  const { message } = App.useApp();
  return (
    <SettingsGroup
      title="事件通知"
      action={
        <Button
          onClick={() => {
            void bridge
              .notify("Live Recorder 提醒", "这是一条桌面通知测试消息")
              .then(() => message.success("桌面通知已发送"))
              .catch((e) =>
                message.error(
                  e instanceof Error ? e.message : "桌面通知测试失败",
                ),
              );
          }}
        >
          测试桌面通知
        </Button>
      }
    >
      <div
        className="lr-notification-matrix"
        role="table"
        aria-label="通知事件设置"
      >
        <div className="lr-notification-matrix__row" role="row">
          <div className="lr-notification-matrix__header" role="columnheader">
            通知事件
          </div>
          <div className="lr-notification-matrix__header" role="columnheader">
            桌面
          </div>
          <div className="lr-notification-matrix__header" role="columnheader">
            邮件
          </div>
        </div>
        {NOTIFICATION_EVENTS.map(([key, label]) => (
          <div className="lr-notification-matrix__row" role="row" key={key}>
            <span role="rowheader">{label}</span>
            {(["desktop", "email"] as const).map((channel) => {
              const id = `notify-${channel}-${key}`;
              return (
                <div
                  role="cell"
                  key={channel}
                  id={id}
                  className="lr-notification-matrix__cell"
                >
                  <span id={`${id}-label`} className="lr-settings-sr-only">
                    {BY_ID[id]!.label}
                  </span>
                  <SettingControl id={id} />
                  <SaveStatus id={id} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <OrdinaryRow id="notification-dedupe" />
    </SettingsGroup>
  );
}
export function ConnectionPanel({ domain }: { domain: "email" | "openlist" }) {
  const model = useSettingsModelContext();
  const { message } = App.useApp();
  const [testing, setTesting] = useState(false);
  const [presets, setPresets] = useState<SmtpPreset[]>([]);
  const email = domain === "email";
  const ids = email
    ? [
        "email-host",
        "email-port",
        "email-secure",
        "email-username",
        "email-from",
        "email-recipients",
        "email-password",
      ]
    : [
        "upload-serverUrl",
        "upload-username",
        "upload-token",
        "upload-directoryTemplate",
      ];
  useEffect(() => {
    if (email)
      void fetchEmailPresets()
        .then(setPresets)
        .catch(() => undefined);
  }, [email]);
  const test = async () => {
    if (!(await model.queue.flush(ids))) {
      message.warning(
        email
          ? "请先修正邮件配置中的无效输入或保存错误"
          : "请先修正连接配置中的无效输入或保存错误",
      );
      return;
    }
    setTesting(true);
    try {
      if (email) await testEmail();
      else {
        const result = await model.testUploadConnection();
        if (result !== "ok") return;
      }
      message.success(email ? "测试邮件已发送" : "连接正常");
    } catch (e) {
      if (!email)
        model.setConnection({
          phase: "error",
          message: e instanceof Error ? e.message : "连接失败",
        });
      message.error(e instanceof Error ? e.message : "测试失败");
    } finally {
      setTesting(false);
    }
  };
  return (
    <SettingsGroup
      title={email ? "邮件连接配置" : "OpenList 连接配置"}
      action={
        <Button
          loading={testing}
          disabled={
            !model.models[domain] ||
            (!email && model.connection.phase === "checking")
          }
          onClick={() => void test()}
        >
          {email ? "发送测试邮件" : "测试连接"}
        </Button>
      }
    >
      {email && (
        <SettingsRow
          id="email-enabled"
          help="邮件通知需要启用总开关；测试邮件不受开关影响。"
        >
          <SettingControl id="email-enabled" />
        </SettingsRow>
      )}
      {!!model.models[domain]?.[email ? "passwordSet" : "hasToken"] && (
        <p>留空不修改现有凭据</p>
      )}
      {email && (
        <div className="lr-settings-row">
          <div className="lr-settings-row__copy">
            <label
              className="lr-settings-row__label"
              htmlFor="email-preset-control"
            >
              邮件服务商
            </label>
          </div>
          <div className="lr-settings-row__control">
            <Select
              id="email-preset-control"
              aria-label="邮件服务商预设"
              placeholder="选择服务商自动填充"
              options={presets.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(id) => {
                const p = presets.find((p) => p.id === id)!;
                for (const [key, v] of Object.entries({
                  host: p.host,
                  port: p.port,
                  secure: p.secure,
                }))
                  model.change(`email-${key}`, v, 0);
              }}
            />
          </div>
        </div>
      )}
      {ids.map((id) => (
        <SettingsRow key={id} id={id}>
          {id === "email-port" ? (
            <InputNumber
              id={`${id}-control`}
              aria-labelledby={`${id}-label`}
              min={1}
              max={65535}
              value={model.value(id) as number | null}
              onChange={(v) => model.change(id, v, 500)}
            />
          ) : (
            <SettingControl id={id} />
          )}
        </SettingsRow>
      ))}
      {!email && model.connection.phase !== "unchecked" && (
        <p
          role="status"
          className={`lr-settings-connection is-${model.connection.phase}`}
        >
          {model.connection.message}
        </p>
      )}
      {!email && (
        <SettingsGroup title="上传">
          <OrdinaryRow id="upload-enabled" />
          <OrdinaryRow id="upload-delete" />
        </SettingsGroup>
      )}
    </SettingsGroup>
  );
}
