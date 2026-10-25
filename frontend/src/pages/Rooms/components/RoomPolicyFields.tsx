import { Link } from "react-router-dom";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { InputNumber, Select, Switch, Tooltip } from "antd";
import type { Platform, RoomEffectivePolicy } from "../../../types/room";
import type { Settings } from "../../../types/settings";
import { bridge } from "../../../stores/bootStore";
import {
  liveNotifyChannels,
  liveNotifySentence,
} from "../../../utils/liveNotifyChannels";
import { QUALITY_OPTIONS, type RoomPolicy } from "../model/roomPolicy";

const INHERIT = "inherit";
const SKIP = "skip";

export function RoomEnabledControl({
  enabled,
  disabled = false,
  onChange,
  compact = false,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
  compact?: boolean;
}) {
  const id = useId();
  return (
    <label
      className={`lr-room-policy-field${compact ? " lr-room-policy-enabled" : ""}`}
      htmlFor={id}
    >
      <span>启用监控</span>
      <Switch
        id={id}
        aria-label="启用监控"
        checked={enabled}
        disabled={disabled}
        onChange={onChange}
      />
    </label>
  );
}
export default function RoomPolicyFields({
  value,
  onChange,
  settings,
  platform,
  effective,
  batch = false,
  disabled = false,
  onValidityChange,
  hideEnabled = false,
  status,
  presentation = "form",
}: {
  value: RoomPolicy;
  onChange: (patch: RoomPolicy) => void;
  settings: Settings | null;
  platform?: Platform;
  /** 后端生效值回传（含来源）；单房呈现优先消费，批量模式无每房生效值。 */
  effective?: RoomEffectivePolicy;
  batch?: boolean;
  disabled?: boolean;
  onValidityChange?: (valid: boolean) => void;
  hideEnabled?: boolean;
  status?: ReactNode;
  presentation?: "form" | "console";
}) {
  const consoleMode = presentation === "console";
  const id = useId();
  // 「跟随全局」标签的基线值=后端 checkIntervalDefaults（含平台默认兑底），前端不再自算。
  const defaultInterval = platform
    ? settings?.checkIntervalDefaults?.[platform]
    : undefined;
  const intervalFollowLabel =
    defaultInterval != null ? `${defaultInterval} 秒` : "默认";
  const intervalDisplay =
    value.checkIntervalSec ??
    effective?.checkIntervalSec.value ??
    defaultInterval;
  // 悬浮提示=真启用渠道清单（开关开+渠道已启用可用）；桌面按系统通知可用计。
  const liveNotify = liveNotifyChannels(
    settings,
    bridge.isDesktop ||
      (typeof Notification !== "undefined" &&
        Notification.permission === "granted"),
  );
  const [intervalDraft, setIntervalDraft] = useState<{
    source: number | null | undefined;
    value: number | null;
  }>({ source: value.checkIntervalSec, value: value.checkIntervalSec ?? 60 });
  const interval =
    intervalDraft.source === value.checkIntervalSec
      ? intervalDraft.value
      : (value.checkIntervalSec ?? 60);
  const intervalError =
    interval === null ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 3600;
  useEffect(() => {
    onValidityChange?.(value.checkIntervalSec == null || !intervalError);
  }, [intervalError, value.checkIntervalSec, onValidityChange]);
  const skip = batch ? [{ value: SKIP, label: "不修改" }] : [];
  const inherit = (label: string) => ({
    value: INHERIT,
    label: `跟随全局${batch ? "" : `（${label}）`}`,
  });
  const keyValue = (key: keyof RoomPolicy): string =>
    value[key] === undefined && batch
      ? SKIP
      : value[key] == null
        ? INHERIT
        : String(value[key]);
  const booleanField = (
    key:
      "enabled" | "autoRecord" | "danmakuEnabled" | "liveNotificationEnabled",
    label: string,
    inherited?: boolean,
    suffix?: ReactNode,
  ) => {
    const active = value[key] ?? inherited ?? false;
    return (
      <label
        className={`lr-room-policy-field${consoleMode ? ` lr-console-pad${active ? " is-on" : ""}` : ""}`}
        htmlFor={`${id}-${key}`}
      >
        <span className={consoleMode ? "lr-console-pad-label" : undefined}>
          {consoleMode && <i aria-hidden="true" />}
          {label}
          {suffix}
        </span>
        {!batch ? (
          <Switch
            id={`${id}-${key}`}
            aria-label={label}
            checked={active}
            disabled={disabled}
            onChange={(checked) => onChange({ [key]: checked })}
            checkedChildren={consoleMode ? "开启" : undefined}
            unCheckedChildren={consoleMode ? "关闭" : undefined}
          />
        ) : (
          <Select
            id={`${id}-${key}`}
            aria-label={label}
            value={keyValue(key)}
            labelRender={
              consoleMode ? () => (active ? "开启" : "关闭") : undefined
            }
            disabled={disabled}
            options={[
              ...skip,
              { value: "true", label: "开启" },
              { value: "false", label: "关闭" },
            ]}
            onChange={(next) =>
              onChange({
                [key]:
                  next === SKIP
                    ? undefined
                    : next === INHERIT
                      ? null
                      : next === "true",
              })
            }
          />
        )}
      </label>
    );
  };
  const intervalTouched = useRef(false);
  const commitInterval = () => {
    if (disabled) return;
    if (
      consoleMode &&
      (!intervalTouched.current ||
        intervalDraft.source !== value.checkIntervalSec)
    )
      return;
    if (intervalError) return;
    intervalTouched.current = false;
    if (interval !== value.checkIntervalSec)
      onChange({ checkIntervalSec: interval });
  };
  const behaviors = (
    <section className="lr-room-policy-behaviors" aria-label="录制与通知">
      <div className="lr-room-policy-group-heading">
        <h3>录制与通知</h3>
        {status}
      </div>
      <div className="lr-room-policy-group-fields">
        {!hideEnabled &&
          (batch ? (
            booleanField("enabled", "启用监控")
          ) : (
            <RoomEnabledControl
              enabled={Boolean(value.enabled)}
              disabled={disabled}
              onChange={(enabled) => onChange({ enabled })}
            />
          ))}
        {booleanField(
          "autoRecord",
          "自动录制",
          effective?.autoRecord.value ?? settings?.autoRecord,
        )}
        {booleanField(
          "danmakuEnabled",
          "弹幕保存",
          effective?.danmakuEnabled.value ?? settings?.danmaku?.enabled,
        )}
        <Tooltip
          title={
            liveNotify.length
              ? liveNotifySentence(liveNotify)
              : "未启用任何通知渠道"
          }
        >
          <div className="lr-room-policy-notification">
            {booleanField(
              "liveNotificationEnabled",
              "开播提醒",
              undefined,
              !batch &&
                value.liveNotificationEnabled === true &&
                liveNotify.length === 0 ? (
                <Link
                  className="lr-room-policy-warning"
                  to="/settings#notifications"
                >
                  未启用任何通知渠道
                </Link>
              ) : undefined,
            )}
          </div>
        </Tooltip>
      </div>
    </section>
  );
  const intervalControls = (
    <div>
      <div
        className={`lr-room-policy-interval-controls${value.checkIntervalSec != null ? " has-custom" : ""}`}
      >
        <Select
          id={`${id}-interval`}
          aria-label="检测间隔模式"
          disabled={disabled}
          value={
            value.checkIntervalSec === undefined && batch
              ? SKIP
              : value.checkIntervalSec == null
                ? INHERIT
                : "custom"
          }
          options={[
            ...skip,
            inherit(intervalFollowLabel),
            { value: "custom", label: "自定义间隔" },
          ]}
          onChange={(next) =>
            onChange({
              checkIntervalSec:
                next === SKIP
                  ? undefined
                  : next === INHERIT
                    ? null
                    : (interval ?? 60),
            })
          }
        />
        {value.checkIntervalSec != null && (
          <InputNumber
            aria-label="检测间隔秒数"
            min={1}
            max={3600}
            precision={0}
            value={interval}
            disabled={disabled}
            suffix="秒"
            status={intervalError ? "error" : undefined}
            onChange={(next) =>
              setIntervalDraft({
                source: value.checkIntervalSec,
                value: next,
              })
            }
            onBlur={commitInterval}
            onPressEnter={commitInterval}
          />
        )}
      </div>
      {value.checkIntervalSec != null && intervalError && (
        <span className="lr-room-policy-error" role="alert">
          请输入 1–3600 的整数
        </span>
      )}
    </div>
  );
  const parameters = (
    <section className="lr-room-policy-parameters" aria-label="检测与画质">
      <div className="lr-room-policy-group-heading">
        <h3>检测与画质</h3>
      </div>
      <div className="lr-room-policy-group-fields">
        <div
          className={`lr-room-policy-field${consoleMode ? " lr-policy-sentence" : ""}`}
        >
          {consoleMode ? (
            <span>每隔</span>
          ) : (
            <label htmlFor={`${id}-interval`}>检测间隔</label>
          )}
          {consoleMode ? (
            <>
              <Select
                className="lr-policy-interval-select"
                aria-label="检测间隔"
                value={
                  value.checkIntervalSec == null
                    ? INHERIT
                    : String(value.checkIntervalSec)
                }
                labelRender={() =>
                  intervalDisplay != null ? `${intervalDisplay} 秒` : ""
                }
                disabled={disabled}
                popupMatchSelectWidth={220}
                options={[
                  inherit(intervalFollowLabel),
                  ...Array.from(
                    new Set([
                      30,
                      60,
                      120,
                      300,
                      600,
                      ...(value.checkIntervalSec == null
                        ? []
                        : [value.checkIntervalSec]),
                    ]),
                  )
                    .sort((a, b) => a - b)
                    .map((seconds) => ({
                      value: String(seconds),
                      label: `${seconds} 秒`,
                    })),
                ]}
                onChange={(next) => {
                  intervalTouched.current = false;
                  onChange({
                    checkIntervalSec: next === INHERIT ? null : Number(next),
                  });
                }}
                popupRender={(menu) => (
                  <>
                    {menu}
                    <div className="lr-policy-custom-interval">
                      <label htmlFor={`${id}-custom-interval`}>
                        自定义秒数
                      </label>
                      <InputNumber
                        id={`${id}-custom-interval`}
                        aria-label="自定义检测间隔秒数"
                        min={1}
                        max={3600}
                        precision={0}
                        value={interval}
                        disabled={disabled}
                        status={intervalError ? "error" : undefined}
                        onChange={(next) => {
                          intervalTouched.current = true;
                          setIntervalDraft({
                            source: value.checkIntervalSec,
                            value: next,
                          });
                        }}
                        onBlur={commitInterval}
                        onPressEnter={commitInterval}
                      />
                      {intervalError && (
                        <span role="alert" className="lr-room-policy-error">
                          请输入 1–3600 的整数
                        </span>
                      )}
                    </div>
                  </>
                )}
              />
              <span>检测一次直播状态，</span>
            </>
          ) : (
            intervalControls
          )}
        </div>
        <label
          className={`lr-room-policy-field${consoleMode ? " lr-policy-sentence" : ""}`}
          htmlFor={`${id}-quality`}
        >
          <span>{consoleMode ? "录制文件保存为" : "录制清晰度"}</span>
          <Select
            id={`${id}-quality`}
            aria-label="录制清晰度"
            popupMatchSelectWidth={consoleMode ? false : undefined}
            value={keyValue("quality")}
            labelRender={
              consoleMode
                ? () =>
                    QUALITY_OPTIONS.find(
                      (option) =>
                        option.value ===
                        (value.quality ??
                          effective?.quality.value ??
                          settings?.quality ??
                          "original"),
                    )?.label
                : undefined
            }
            disabled={disabled}
            options={[
              ...skip,
              inherit(
                QUALITY_OPTIONS.find(
                  (option) => option.value === settings?.quality,
                )?.label ?? "原画",
              ),
              ...QUALITY_OPTIONS,
            ]}
            onChange={(next) =>
              onChange({
                quality:
                  next === SKIP
                    ? undefined
                    : next === INHERIT
                      ? null
                      : (next as RoomPolicy["quality"]),
              })
            }
          />
        </label>
      </div>
    </section>
  );
  return consoleMode ? (
    <div className="lr-room-policy-console">
      {parameters}
      {behaviors}
    </div>
  ) : (
    <>
      {behaviors}
      {parameters}
    </>
  );
}
