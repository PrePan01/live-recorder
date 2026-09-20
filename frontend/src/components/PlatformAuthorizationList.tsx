import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { App, Button, Tag, Typography } from "antd";
import { bridge } from "../stores/bootStore";
import {
  fetchBilibiliCookieStatus,
  fetchDouyinCookieStatus,
} from "../api/settings";
import type { Settings } from "../types/settings";
import type { Platform } from "../types/room";
import {
  credentialStatus,
  type CookieProbeStatus,
  type CredentialStatus,
} from "../utils/credentialStatus";
import { PlatformIcon } from "./PlatformLogo";

export interface PlatformAuthorizationConfig {
  platform: Platform;
  label: string;
  anchor: string;
  unauthorizedHint: string;
  cookieField: "douyinCookie" | "bilibiliCookie";
  manualHost: string;
  manualPlaceholder: string;
}

/**
 * 平台授权入口集中在此配置中；新增需要登录的平台时补充一项和对应桥接/API 即可。
 */
const PLATFORM_AUTHORIZATION_CONFIGS: PlatformAuthorizationConfig[] = [
  {
    platform: "douyin",
    label: "抖音",
    anchor: "douyin-cookie",
    unauthorizedHint: "未授权将无法观看与录制抖音直播间",
    cookieField: "douyinCookie",
    manualHost: "live.douyin.com",
    manualPlaceholder: "粘贴完整抖音 Cookie",
  },
  {
    platform: "bilibili",
    label: "B站",
    anchor: "bilibili-cookie",
    unauthorizedHint: "未登录时最高只能观看、录制 720p",
    cookieField: "bilibiliCookie",
    manualHost: "live.bilibili.com",
    manualPlaceholder: "粘贴完整B站 Cookie",
  },
];

const STATUS_TEXT: Record<CredentialStatus, string> = {
  authorized: "已登录",
  invalid: "登录已失效",
  unauthorized: "未登录",
};

export type PlatformAuthorizationStatuses = Partial<
  Record<Platform, CredentialStatus>
>;

interface PlatformAuthorizationListProps {
  settings: Settings | null;
  /** 登录成功后由页面刷新 Settings store，避免各页面各自维护 Cookie 标记。 */
  onAuthorized: () => Promise<void>;
  /** 设置页传入清除操作；首次向导无需暴露此高阶操作。 */
  onClear?: (platform: Platform) => void;
  /** 设置页用它附加手动 Cookie 高级入口；首次向导保持简洁。 */
  renderSupplement?: (
    config: PlatformAuthorizationConfig,
    hasCookie: boolean,
  ) => ReactNode;
  onStatusesChange?: (statuses: PlatformAuthorizationStatuses) => void;
  showPrivacyNote?: boolean;
}

async function fetchStatus(platform: Platform): Promise<CookieProbeStatus> {
  return platform === "douyin"
    ? fetchDouyinCookieStatus()
    : fetchBilibiliCookieStatus();
}

function startAuthorization(platform: Platform): Promise<void> {
  return platform === "douyin"
    ? bridge.startDouyinAuthorization()
    : bridge.startBilibiliAuthorization();
}

function authorizedEvent(platform: Platform, callback: () => void): () => void {
  return platform === "douyin"
    ? bridge.onDouyinAuthorized(callback)
    : bridge.onBilibiliAuthorized(callback);
}

function resolveStatuses(
  settings: Settings | null,
  probes: Partial<Record<Platform, CookieProbeStatus | null>>,
): PlatformAuthorizationStatuses {
  return PLATFORM_AUTHORIZATION_CONFIGS.reduce<PlatformAuthorizationStatuses>(
    (result, config) => {
      const hasCookie = settings?.[config.cookieField].hasCookie ?? false;
      result[config.platform] = credentialStatus(
        probes[config.platform] ?? null,
        hasCookie,
      );
      return result;
    },
    {},
  );
}

export default function PlatformAuthorizationList({
  settings,
  onAuthorized,
  onClear,
  renderSupplement,
  onStatusesChange,
  showPrivacyNote = true,
}: PlatformAuthorizationListProps) {
  const { message } = App.useApp();
  const [probes, setProbes] = useState<
    Partial<Record<Platform, CookieProbeStatus | null>>
  >({});
  const [authorizing, setAuthorizing] = useState<
    Partial<Record<Platform, boolean>>
  >({});

  const updateProbe = useCallback(
    (platform: Platform, probe: CookieProbeStatus) => {
      setProbes((current) => {
        const next = { ...current, [platform]: probe };
        onStatusesChange?.(resolveStatuses(settings, next));
        return next;
      });
    },
    [onStatusesChange, settings],
  );

  const refreshStatus = useCallback(
    async (platform: Platform) => {
      try {
        updateProbe(platform, await fetchStatus(platform));
      } catch {
        updateProbe(platform, "unknown");
      }
    },
    [updateProbe],
  );

  useEffect(() => {
    for (const config of PLATFORM_AUTHORIZATION_CONFIGS) {
      void refreshStatus(config.platform);
    }
  }, [refreshStatus]);

  useEffect(() => {
    const listeners = PLATFORM_AUTHORIZATION_CONFIGS.map((config) =>
      authorizedEvent(config.platform, () => {
        void (async () => {
          await onAuthorized();
          await refreshStatus(config.platform);
          message.success(`${config.label}授权已完成`);
        })();
      }),
    );
    return () => listeners.forEach((dispose) => dispose());
  }, [message, onAuthorized, refreshStatus]);

  const statuses = useMemo(
    () => resolveStatuses(settings, probes),
    [probes, settings],
  );

  const authorize = async (config: PlatformAuthorizationConfig) => {
    setAuthorizing((current) => ({ ...current, [config.platform]: true }));
    try {
      await startAuthorization(config.platform);
      message.info(`请在新窗口完成${config.label}登录，完成后回到此处确认。`);
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : `无法打开${config.label}授权窗口`,
      );
    } finally {
      setAuthorizing((current) => ({ ...current, [config.platform]: false }));
    }
  };

  return (
    <>
      <div className="lr-credential-list">
        {PLATFORM_AUTHORIZATION_CONFIGS.map((config) => {
          const status = statuses[config.platform] ?? "unauthorized";
          const hasCookie = settings?.[config.cookieField].hasCookie ?? false;
          const authorized = status !== "unauthorized";
          return (
            <div
              id={config.anchor}
              className="lr-credential-row"
              key={config.platform}
            >
              <div className="lr-credential-row__main">
                <div className="lr-credential-row__platform">
                  <span className="lr-credential-row__name">
                    <PlatformIcon platform={config.platform} size={18} />
                    <Typography.Text strong>{config.label}</Typography.Text>
                  </span>
                  <Tag
                    color={
                      status === "invalid"
                        ? "error"
                        : authorized
                          ? "success"
                          : "default"
                    }
                  >
                    {STATUS_TEXT[status]}
                  </Tag>
                </div>
                <div className="lr-credential-row__state">
                  {status === "authorized" ? null : (
                    <Typography.Text
                      type={status === "invalid" ? "danger" : "secondary"}
                    >
                      {status === "invalid"
                        ? "请重新登录"
                        : config.unauthorizedHint}
                    </Typography.Text>
                  )}
                </div>
                <div className="lr-credential-row__actions">
                  {bridge.isDesktop ? (
                    <Button
                      type={authorized ? "default" : "primary"}
                      loading={authorizing[config.platform] ?? false}
                      onClick={() => void authorize(config)}
                    >
                      {authorized ? "重新登录" : "登录并授权"}
                    </Button>
                  ) : (
                    <Typography.Text type="secondary">
                      请用桌面客户端登录
                    </Typography.Text>
                  )}
                  {onClear ? (
                    <Button
                      type="text"
                      danger
                      disabled={!authorized}
                      onClick={() => onClear(config.platform)}
                    >
                      清除
                    </Button>
                  ) : null}
                </div>
              </div>
              {renderSupplement?.(config, hasCookie)}
            </div>
          );
        })}
      </div>
      {showPrivacyNote ? (
        <Typography.Text
          className="lr-credential-list__privacy"
          type="secondary"
        >
          Cookie 仅保存在本地，不会上传或提供给他人，可随时清除，请放心。
        </Typography.Text>
      ) : null}
    </>
  );
}
