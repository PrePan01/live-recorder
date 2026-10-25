import { useEffect, useRef, useState } from "react";
import { App, Button, InputNumber, Select, Switch } from "antd";
import { useSettingsModelContext } from "../model/SettingsContext";
import { BY_ID } from "../model/catalog";
import { missingEmailConfiguration } from "../model/emailConfiguration";
import {
  OrdinaryRow,
  SettingControl,
  SettingsGroup,
  SettingsRow,
} from "./SettingsPrimitives";
import {
  fetchEmailPresets,
  testEmail,
  type SmtpPreset,
} from "../../../api/email";

export function ConnectionPanel({ domain }: { domain: "email" | "openlist" }) {
  const model = useSettingsModelContext();
  const { message } = App.useApp();
  const [testing, setTesting] = useState(false);
  const [presets, setPresets] = useState<SmtpPreset[]>([]);
  const email = domain === "email";
  const [configurationMissing, setConfigurationMissing] = useState(false);
  const emailEnabled = model.value("email-enabled") === true;
  const missing = email
    ? missingEmailConfiguration(
        model.value,
        model.models.email?.passwordSet === true,
      )
    : [];
  const configured = missing.length === 0;
  const [testResult, setTestResult] = useState<{
    signature: string;
    text: string;
  } | null>(null);
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
  const signature = JSON.stringify([
    model.models[domain],
    ...ids.map((id) => model.value(id)),
    email && model.value("email-enabled"),
  ]);
  const currentSignature = useRef(signature);
  useEffect(() => {
    currentSignature.current = signature;
  }, [signature]);
  useEffect(() => {
    if (email)
      void fetchEmailPresets()
        .then(setPresets)
        .catch(() => undefined);
  }, [email]);
  const test = async () => {
    setTestResult(null);
    if (!(await model.queue.flush(email ? [...ids, "email-enabled"] : ids))) {
      message.warning({
        className: email ? undefined : "lr-upload-warning-message",
        content: email
          ? "请先修正邮件配置中的无效输入或保存错误"
          : "请先修正连接配置中的无效输入或保存错误",
      });
      return;
    }
    setTesting(true);
    const testedSignature = currentSignature.current;
    try {
      if (email) await testEmail();
      else {
        const result = await model.testUploadConnection();
        if (result !== "ok") return;
      }
      if (email)
        setTestResult({ signature: testedSignature, text: "测试邮件已发送" });
      message.success(email ? "测试邮件已发送" : "连接正常");
    } catch (e) {
      if (email)
        setTestResult({
          signature: testedSignature,
          text: e instanceof Error ? e.message : "测试失败",
        });
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
      title={email ? "邮件通知" : "OpenList 连接配置"}
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
      {email && !model.models.email && (
        <p className="lr-notification-status">正在加载…</p>
      )}
      {email &&
        model.models.email &&
        !configured &&
        (configurationMissing || emailEnabled) && (
          <p role="alert" className="lr-notification-key-error">
            请填写 {missing.map((id) => BY_ID[id]!.label).join("、")} 配置
          </p>
        )}
      {email && testResult?.signature === signature && (
        <p role="status">{testResult.text}</p>
      )}
      {email && (
        <SettingsRow id="email-enabled">
          <Switch
            id="email-enabled-control"
            aria-labelledby="email-enabled-label"
            aria-label="启用邮件通知"
            checked={emailEnabled && configured}
            disabled={!model.loaded("email-enabled")}
            onChange={(checked) => {
              if (checked && !configured) {
                setConfigurationMissing(true);
                model.change("email-enabled", false);
                return;
              }
              setConfigurationMissing(false);
              model.change("email-enabled", checked);
            }}
          />
        </SettingsRow>
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
