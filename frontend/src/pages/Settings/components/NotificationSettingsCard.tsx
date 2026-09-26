import {
  App,
  Button,
  Card,
  Form,
  InputNumber,
  Space,
  Switch,
  Typography,
} from "antd";
import { useNotificationStore } from "../../../stores/notificationStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { bridge } from "../../../stores/bootStore";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/errorMap";
import type { NotificationEventPreference } from "../../../types/notification";
import EmailConfigCard from "../../../components/EmailConfigCard";

const NOTIFICATION_EVENTS: Array<{
  key: keyof NotificationEventPreference;
  label: string;
}> = [
  { key: "liveStarted", label: "开播提醒" },
  { key: "recordingStarted", label: "录制开始" },
  { key: "recordingEnded", label: "录制结束" },
  { key: "recordingFailed", label: "录制失败" },
  { key: "diskSpaceLow", label: "磁盘空间不足" },
  { key: "uploadFailed", label: "上传失败" },
];
/** 通知设置卡：原 Settings/index 内联通知矩阵整块迁移（store 直连，去重时间/开关语义原样）。 */
export default function NotificationSettingsCard() {
  const { message } = App.useApp();
  const settings = useSettingsStore((s) => s.settings);
  const emailNotificationsEnabled = settings?.mail.enabled ?? false;
  const { preferences, save: saveNotifications } = useNotificationStore();
  const sendDesktopTest = async () => {
    try {
      await bridge.notify("Live Recorder提醒", "这是一条桌面通知测试消息");
      message.success("桌面通知已发送");
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "测试通知失败",
      );
    }
  };
  return (
    <Card className="lr-settings-card lr-notification-card" title="通知设置">
      <Space
        className="lr-notification-settings"
        orientation="vertical"
        style={{ width: "100%" }}
        size={16}
      >
        <div className="lr-notification-matrix">
          <div className="lr-notification-matrix__header">通知事件</div>
          <div className="lr-notification-matrix__header">桌面通知</div>
          <div className="lr-notification-matrix__header">邮件通知</div>
          {NOTIFICATION_EVENTS.map(({ key, label }) => (
            <div className="lr-notification-matrix__row" key={key}>
              <span>{label}</span>
              <div className="lr-notification-matrix__cell">
                <Switch
                  aria-label={`${label} 桌面通知`}
                  checked={preferences?.desktop[key] ?? false}
                  onChange={(value) =>
                    void saveNotifications({
                      desktop: {
                        [key]: value,
                      } as Partial<NotificationEventPreference>,
                    }).catch(() => message.error("保存失败"))
                  }
                />
              </div>
              <div className="lr-notification-matrix__cell">
                <Switch
                  aria-label={`${label} 邮件通知`}
                  checked={preferences?.email[key] ?? false}
                  disabled={!emailNotificationsEnabled}
                  onChange={(value) =>
                    void saveNotifications({
                      email: {
                        [key]: value,
                      } as Partial<NotificationEventPreference>,
                    }).catch(() => message.error("保存失败"))
                  }
                />
              </div>
            </div>
          ))}
        </div>
        <Form.Item label="通知去重时间（分钟）" style={{ marginBottom: 0 }}>
          <InputNumber
            aria-label="通知去重时间（分钟）"
            min={1}
            max={1440}
            value={preferences?.dedupeWindowMinutes}
            onChange={(v) => {
              if (typeof v === "number" && v >= 1 && v <= 1440) {
                void saveNotifications({ dedupeWindowMinutes: v }).catch(() =>
                  message.error("保存失败"),
                );
              }
            }}
          />
        </Form.Item>
        <Button size="small" onClick={() => void sendDesktopTest()}>
          发送桌面测试
        </Button>
        <div className="lr-notification-email-config">
          <Typography.Title level={5}>邮件服务</Typography.Title>
          <Typography.Paragraph type="secondary">
            邮件通知需要启用下方总开关；测试邮件不受开关影响。
          </Typography.Paragraph>
          <EmailConfigCard />
        </div>
      </Space>
    </Card>
  );
}
