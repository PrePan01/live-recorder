import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Slider,
  Space,
  Switch,
  Tooltip,
  Typography,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type { FormInstance } from "antd";
import DirectoryPicker from "../../../components/DirectoryPicker";
import PlatformAuthorizationList, {
  type PlatformAuthorizationConfig,
} from "../../../components/PlatformAuthorizationList";
import MemphisRadioGroup from "../../../components/MemphisRadioGroup";
import type {
  ThemePreference,
  SettingsInput,
  Settings,
} from "../../../types/settings";
import saveCookieTutorial from "../../../assets/img/save_cookie.png";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];
function CredentialManual({
  config,
  hasCookie,
}: {
  config: PlatformAuthorizationConfig;
  hasCookie: boolean;
}) {
  const tutorialImage =
    config.platform === "douyin" ? saveCookieTutorial : undefined;
  return (
    <Collapse
      className="lr-credential-manual"
      ghost
      items={[
        {
          key: "manual-cookie",
          label: "手动粘贴 Cookie（高级）",
          children: (
            <div className="lr-credential-manual__content">
              <Typography.Paragraph type="secondary">
                进入网页版{config.label}并登录，打开任意直播间后按 F12 →
                网络（Network） → 刷新页面 → 点开任意{" "}
                <Typography.Text code>{config.manualHost}</Typography.Text> 请求
                → 在「请求标头」复制完整 Cookie 并粘贴。
                {tutorialImage ? (
                  <span className="lr-network-help">
                    <Tooltip
                      styles={{
                        root: {
                          width: "min(600px, calc(100vw - 48px))",
                          maxWidth: "none",
                        },
                      }}
                      title={
                        <img
                          alt={`从网络面板保存${config.label} Cookie 的教程`}
                          className="lr-cookie-tutorial-image"
                          src={tutorialImage}
                        />
                      }
                      placement="top"
                    >
                      <Button
                        aria-label={`查看${config.label}网络面板 Cookie 教程`}
                        className="lr-inline-icon-button"
                        size="small"
                        type="text"
                        icon={<QuestionCircleOutlined />}
                      />
                    </Tooltip>
                  </span>
                ) : null}
              </Typography.Paragraph>
              <Form.Item
                name={config.cookieField}
                extra={hasCookie ? "已保存；留空则不修改" : undefined}
              >
                <Input.Password
                  placeholder={hasCookie ? "••••••" : config.manualPlaceholder}
                  autoComplete="new-password"
                />
              </Form.Item>
            </div>
          ),
        },
      ]}
    />
  );
}

export interface ServiceSettingsCardProps {
  form: FormInstance;
  settings: Settings | null;
  preference: ThemePreference;
  showGlobalSearch: boolean;
  setShowGlobalSearch: (v: boolean) => void;
  onValuesChange: (changed: unknown, all: SettingsInput) => void;
  checkDir: () => Promise<void>;
  dirMsg: { ok: boolean; text: string } | null;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  load: () => Promise<void>;
  persist: (
    values: SettingsInput,
    clearCookies?: { douyin?: boolean; bilibili?: boolean },
  ) => Promise<boolean>;
  showFfmpegWarning: boolean;
  ffmpegInstallCmd: string;
  windowWindows: boolean;
  fileRef: React.RefObject<HTMLInputElement | null>;
  setPreference: (theme: ThemePreference) => void;
  debounceRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  onImportFile: (file: File) => Promise<void>;
}

/** 服务设置卡：原 Settings/index 内联服务表单整块迁移（Form/持久化仍在页面，行为与手改原样）。 */
export default function ServiceSettingsCard(props: ServiceSettingsCardProps) {
  const {
    form,
    settings,
    preference,
    showGlobalSearch,
    setShowGlobalSearch,
    onValuesChange,
    checkDir,
    dirMsg,
    pickerOpen,
    setPickerOpen,
    load,
    persist,
    showFfmpegWarning,
    ffmpegInstallCmd,
    windowWindows,
    fileRef,
    onImportFile,
    setPreference,
    debounceRef,
  } = props;
  const { message } = App.useApp();
  return (
    <Card
      className="lr-settings-card lr-settings-card--primary"
      title="服务设置"
    >
      <Form
        className="lr-settings-form"
        form={form}
        layout="vertical"
        onValuesChange={onValuesChange}
        disabled={!settings}
      >
        <div className="lr-settings-section">
          <Typography.Title className="lr-settings-section__title" level={4}>
            外观与存储
          </Typography.Title>
          <Form.Item label="主题" name="theme">
            <MemphisRadioGroup
              options={THEME_OPTIONS}
              value={preference}
              onChange={(e) => setPreference(e.target.value as ThemePreference)}
            />
          </Form.Item>
          <Form.Item label="显示底部全局搜索">
            <Switch
              aria-label="显示底部全局搜索"
              checked={showGlobalSearch}
              onChange={setShowGlobalSearch}
              disabled={false}
            />
          </Form.Item>
          <Form.Item
            className="lr-floating-recorder-size"
            label="全局录制按钮大小"
          >
            <div className="lr-floating-recorder-size__control">
              <Form.Item name="floatingRecorderSize" noStyle>
                <Slider
                  aria-label="全局录制按钮大小"
                  min={20}
                  max={100}
                  step={1}
                  tooltip={{ formatter: (value) => `${value ?? 36}px` }}
                />
              </Form.Item>
            </div>
          </Form.Item>
          <Form.Item label="保存目录">
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item
                name="recordingDirectory"
                noStyle
                rules={[{ required: true, message: "必填" }]}
              >
                <Input aria-label="保存目录" onBlur={() => void checkDir()} />
              </Form.Item>
              <Button onClick={() => setPickerOpen(true)}>浏览…</Button>
              <Button onClick={() => void checkDir()}>校验</Button>
            </Space.Compact>
          </Form.Item>
          {dirMsg && (
            <Typography.Paragraph
              className="lr-settings-directory-status"
              type={dirMsg.ok ? "success" : "danger"}
            >
              {dirMsg.text}
            </Typography.Paragraph>
          )}
        </div>
        <div className="lr-settings-section">
          <Typography.Title className="lr-settings-section__title" level={4}>
            录制行为
          </Typography.Title>
          <Form.Item
            label="录制完成后询问是否保留"
            name="confirmAfterComplete"
            valuePropName="checked"
          >
            <Switch aria-label="录制完成后询问是否保留" />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item
                label="最大并发"
                name="maxConcurrentRecordings"
                rules={[{ required: true }]}
                extra="可同时录制的直播间数量"
              >
                <InputNumber min={1} max={8} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                label="默认清晰度"
                name="quality"
                extra="拿不到所选清晰度时，自动改录能录到的最高清晰度"
              >
                <Select
                  aria-label="默认清晰度"
                  options={[
                    { value: "original", label: "原画" },
                    { value: "1080p", label: "1080p" },
                    { value: "720p", label: "720p" },
                    { value: "360p", label: "360p" },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                label="录制格式"
                name="recordingFormat"
                extra="FLV：无损最快；MP4：录制完成后自动转换，依赖FFmpeg"
              >
                <Select
                  aria-label="录制格式"
                  options={[
                    { value: "source_flv", label: "FLV" },
                    { value: "mp4_after", label: "MP4" },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          {showFfmpegWarning ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="未检测到 ffmpeg，录制完成后转 MP4 不可用"
              description={
                <Typography.Text>
                  请安装视频工具 ffmpeg 后重试（
                  {windowWindows
                    ? "Windows 在 PowerShell 执行"
                    : "macOS 在终端执行"}
                  ）：{" "}
                  <Typography.Text code>{ffmpegInstallCmd}</Typography.Text>
                  ，安装完成后点击「一键自检」重新检测。
                </Typography.Text>
              }
            />
          ) : null}
          <div className="lr-settings-section">
            <Typography.Title className="lr-settings-section__title" level={4}>
              自动录制
            </Typography.Title>
            <Form.Item
              label="检测到开播自动录制"
              name="autoRecord"
              valuePropName="checked"
            >
              <Switch aria-label="检测到开播自动录制" />
            </Form.Item>
            <Typography.Title className="lr-settings-section__title" level={5}>
              检测频率
            </Typography.Title>
            <Typography.Paragraph
              className="lr-settings-section__hint"
              type="secondary"
            >
              按平台设置开播状态的检查间隔（秒），数值越小响应越快。
            </Typography.Paragraph>
            <Row gutter={16}>
              <Col xs={24} md={8}>
                <Form.Item
                  label="全局默认"
                  name={["checkIntervalSec", "default"]}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={10} max={3600} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  label="B站"
                  name={["checkIntervalSec", "bilibili"]}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={10} max={3600} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  label="抖音"
                  name={["checkIntervalSec", "douyin"]}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={10} max={3600} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
            </Row>
          </div>
          <div className="lr-settings-section">
            <Typography.Title className="lr-settings-section__title" level={4}>
              精彩时刻
            </Typography.Title>
            <Typography.Paragraph
              className="lr-settings-section__hint"
              type="secondary"
            >
              录制当前时刻之前的片段，最高支持 600 秒。
            </Typography.Paragraph>
            <Form.Item
              label="开启精彩时刻"
              name="highlightEnabled"
              valuePropName="checked"
            >
              <Switch aria-label="开启精彩时刻" />
            </Form.Item>
            <Form.Item
              label="精彩时刻缓存上限"
              name="highlightBufferSeconds"
              rules={[{ required: true }]}
            >
              <InputNumber min={5} max={600} addonAfter="秒" />
            </Form.Item>
          </div>
        </div>
        <div className="lr-settings-section lr-settings-section--credential">
          <Typography.Title className="lr-settings-section__title" level={4}>
            平台授权
          </Typography.Title>
          <PlatformAuthorizationList
            settings={settings}
            onAuthorized={load}
            onClear={(platform) => {
              const cookieField =
                platform === "douyin" ? "douyinCookie" : "bilibiliCookie";
              form.setFieldValue(cookieField, "");
              void persist(
                form.getFieldsValue() as SettingsInput,
                platform === "douyin" ? { douyin: true } : { bilibili: true },
              );
            }}
            renderSupplement={(config, hasCookie) => (
              <CredentialManual config={config} hasCookie={hasCookie} />
            )}
          />
        </div>
      </Form>
      <DirectoryPicker
        open={pickerOpen}
        initialPath={settings?.recordingDirectory}
        onClose={() => setPickerOpen(false)}
        onPick={(dir) => {
          // setFieldValue 不会触发 Form 的 onValuesChange；如果只回填表单，
          // 离开页面后重新加载设置时会丢失目录选择。
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          form.setFieldValue("recordingDirectory", dir);
          void persist({
            ...form.getFieldsValue(),
            recordingDirectory: dir,
          } as SettingsInput).then((saved) => {
            if (saved) message.success("目录已选择并保存");
          });
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImportFile(f);
        }}
      />
    </Card>
  );
}
