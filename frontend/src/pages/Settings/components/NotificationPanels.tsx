import { useEffect, useRef, useState } from "react";
import { Button, Switch } from "antd";
import { testQmsg } from "../../../api/qmsg";
import { BY_ID, NOTIFICATION_EVENTS, validateValue } from "../model/catalog";
import { useSettingsModelContext } from "../model/SettingsContext";
import {
  SaveStatus,
  SettingControl,
  SettingsGroup,
  SettingsRow,
} from "./SettingsPrimitives";
import { ConnectionPanel } from "./ConnectionPanel";

const NOTIFICATION_COLUMNS = [
  { key: "desktop", label: "桌面", anchor: "notification-desktop" },
  { key: "email", label: "邮件", anchor: "notification-email" },
  { key: "qq", label: "QQ", anchor: "notification-qq" },
] as const;

export function NotificationEventTable() {
  const model = useSettingsModelContext();
  return (
    <div className="lr-settings-group">
      <div
        className="lr-notification-table-scroll"
        role="region"
        aria-label="通知事件设置"
        aria-describedby="notification-table-hint"
        tabIndex={0}
      >
        <table className="lr-notification-matrix">
          <caption className="lr-settings-sr-only">通知事件与投递渠道</caption>
          <thead>
            <tr>
              <th scope="col">通知事件</th>
              {NOTIFICATION_COLUMNS.map((channel) => {
                const enabledId =
                  channel.key === "qq" ? "qmsg-enabled" : "email-enabled";
                const disabled =
                  channel.key !== "desktop" &&
                  model.loaded(enabledId) &&
                  model.value(enabledId) !== true;
                return (
                  <th
                    key={channel.key}
                    scope="col"
                    className={`is-${channel.key}`}
                  >
                    <span
                      id={
                        channel.key === "desktop"
                          ? "notification-desktop"
                          : undefined
                      }
                      className="lr-notification-column-label"
                    >
                      <span>
                        {channel.key === "desktop" ? (
                          channel.label
                        ) : (
                          <a href={`#${channel.anchor}`}>{channel.label}</a>
                        )}
                        {disabled && (
                          <span className="lr-notification-column-state">
                            （未开启）
                          </span>
                        )}
                      </span>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_EVENTS.map(([key, label]) => (
              <tr key={key}>
                <th scope="row">
                  <div className="lr-notification-event-action">
                    <span>{label}</span>
                    {!NOTIFICATION_COLUMNS.every(
                      (channel) =>
                        model.value(`notify-${channel.key}-${key}`) === true,
                    ) && (
                      <Button
                        size="small"
                        type="text"
                        className="lr-notification-enable-all"
                        aria-label={`全部开启${label}的所有渠道通知`}
                        disabled={NOTIFICATION_COLUMNS.some(
                          (channel) =>
                            !model.loaded(`notify-${channel.key}-${key}`),
                        )}
                        loading={
                          model.states?.[`notify-all-${key}`]?.phase ===
                          "saving"
                        }
                        onClick={() => {
                          const group = `notify-all-${key}`;
                          const ids = NOTIFICATION_COLUMNS.map(
                            (channel) => `notify-${channel.key}-${key}`,
                          );
                          model.discard(group, ids);
                          for (const id of ids) {
                            model.discard(id);
                            model.change(id, true, 0, group);
                          }
                          model.submit(group, ids);
                        }}
                      >
                        全部开启
                      </Button>
                    )}
                  </div>
                  <SaveStatus id={`notify-all-${key}`} />
                </th>
                {NOTIFICATION_COLUMNS.map((channel) => {
                  const id = `notify-${channel.key}-${key}`;
                  return (
                    <td key={channel.key} id={id}>
                      <span id={`${id}-label`} className="lr-settings-sr-only">
                        {BY_ID[id]!.label}
                      </span>
                      <div className="lr-notification-matrix-control">
                        <SettingControl id={id} />
                      </div>
                      <SaveStatus id={id} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} id="notification-dedupe">
                <div className="lr-notification-dedupe">
                  <label
                    id="notification-dedupe-label"
                    htmlFor="notification-dedupe-control"
                  >
                    重复提醒间隔
                  </label>
                  <SettingControl id="notification-dedupe" />
                </div>
                <SaveStatus id="notification-dedupe" />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function QmsgNotifications() {
  const model = useSettingsModelContext();
  const [testing, setTesting] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);
  const [result, setResult] = useState<{
    signature: string;
    text: string;
  } | null>(null);
  // Draft edits and confirmed writes invalidate previous/in-flight test results.
  const signature = JSON.stringify([
    model.models.qmsg,
    model.value("qmsg-key"),
    model.value("qmsg-enabled"),
  ]);
  const currentSignature = useRef(signature);
  useEffect(() => {
    currentSignature.current = signature;
  }, [signature]);
  const configured = model.models.qmsg?.keySet === true;
  const enabled = model.value("qmsg-enabled") === true;
  const test = async () => {
    setTesting(true);
    setResult(null);
    let testedSignature = currentSignature.current;
    try {
      if (
        !(await model.queue.flush([
          "qmsg-enabled",
          "qmsg-key",
          "qmsg-key-manual",
        ]))
      )
        throw new Error("请先保存 Key，并修正 QQ 配置中的保存错误");
      testedSignature = currentSignature.current;
      await testQmsg();
      setResult({
        signature: testedSignature,
        text: "已发送 QQ 测试消息，请检查 QQ Qmsg酱 机器人消息",
      });
    } catch (e) {
      setResult({
        signature: testedSignature,
        text: e instanceof Error ? e.message : "QQ 测试失败",
      });
    } finally {
      setTesting(false);
    }
  };
  return (
    <section
      id="notification-qq"
      className="lr-notification-card is-qq"
      aria-label="QQ 通知"
    >
      <SettingsGroup
        title="QQ 通知"
        action={
          <Button
            loading={testing}
            disabled={!model.models.qmsg || !configured}
            onClick={() => void test()}
          >
            发送 QQ 测试消息
          </Button>
        }
      >
        {!model.models.qmsg && (
          <p className="lr-notification-status">正在加载…</p>
        )}
        {!configured && (keyMissing || enabled) && (
          <p role="alert" className="lr-notification-key-error">
            Qmsg API Key 待配置
          </p>
        )}
        <p className="lr-notification-help">
          若要开启 QQ 通知，请先在{" "}
          <a
            href="https://qmsg.zendee.cn/user"
            target="_blank"
            rel="noreferrer"
          >
            Qmsg 控制台
          </a>
          获取 API Key，扫码添加机器人为好友，再向机器人发送 API Key
          完成绑定，并将 API Key 填入下方。
          <a
            href="https://qmsg.zendee.cn/docs#quick-start"
            target="_blank"
            rel="noreferrer"
          >
            查看详细使用方法
          </a>
        </p>

        <SettingsRow id="qmsg-enabled">
          <Switch
            id="qmsg-enabled-control"
            aria-labelledby="qmsg-enabled-label"
            aria-label="启用 QQ 通知"
            checked={enabled && configured}
            disabled={!model.loaded("qmsg-enabled")}
            onChange={(checked) => {
              if (checked && !configured) {
                setKeyMissing(true);
                model.change("qmsg-enabled", false);
                return;
              }
              setKeyMissing(false);
              model.change("qmsg-enabled", checked);
            }}
          />
        </SettingsRow>
        <SettingsRow id="qmsg-key" wide>
          <div className="lr-notification-key-editor">
            <SettingControl id="qmsg-key" manualGroup="qmsg-key-manual" />
            <Button
              disabled={!model.loaded("qmsg-key")}
              onClick={() =>
                model.submit(
                  "qmsg-key-manual",
                  ["qmsg-key"],
                  validateValue(BY_ID["qmsg-key"]!, model.value("qmsg-key")),
                )
              }
            >
              保存
            </Button>
            <Button disabled={!configured} onClick={model.clearQmsgKey}>
              清除
            </Button>
          </div>
          <SaveStatus id="qmsg-key-manual" />
          <p className="lr-settings-note">
            {configured ? "Key 已保存" : "尚未保存 Key"}
          </p>
        </SettingsRow>
        {result && result.signature === signature && (
          <p role="status">{result.text}</p>
        )}
      </SettingsGroup>
    </section>
  );
}

export function NotificationPanel() {
  return (
    <>
      <NotificationEventTable />
      <div className="lr-notification-channels">
        <section
          id="notification-email"
          className="lr-notification-card is-email"
          aria-label="邮件通知"
        >
          <ConnectionPanel domain="email" />
        </section>
        <QmsgNotifications />
      </div>
    </>
  );
}
