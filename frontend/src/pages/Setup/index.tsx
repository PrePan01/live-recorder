import { useCallback, useEffect, useRef, useState } from "react";
import {
  App,
  Button,
  Card,
  Input,
  InputNumber,
  Select,
  Space,
  Steps,
  Switch,
  Typography,
} from "antd";
import { useNavigate } from "react-router-dom";
import { validateDirectory, updateSettings } from "../../api/settings";
import { useSettingsStore } from "../../stores/settingsStore";
import { useServiceStore } from "../../stores/serviceStore";
import { describeError } from "../../utils/errorMap";
import { ApiError } from "../../types/error";
import DirectoryPicker from "../../components/DirectoryPicker";
import PlatformAuthorizationList, {
  type PlatformAuthorizationStatuses,
} from "../../components/PlatformAuthorizationList";
import type { Quality } from "../../types/settings";

const qualityOptions = [
  { value: "original", label: "原画" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "360p", label: "360p" },
];

interface DirState {
  checking: boolean;
  valid: boolean | null;
  message: string | null;
}

export default function Setup() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const settings = useSettingsStore((s) => s.settings);
  const load = useSettingsStore((s) => s.load);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<string>(settings?.recordingDirectory ?? "");
  const [dirState, setDirState] = useState<DirState>({
    checking: false,
    valid: null,
    message: null,
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const validationId = useRef(0);
  const [concurrency, setConcurrency] = useState<number>(
    settings?.maxConcurrentRecordings ?? 2,
  );
  const [quality, setQuality] = useState<Quality>(
    settings?.quality ?? "original",
  );
  const [autoRecord, setAutoRecord] = useState(settings?.autoRecord ?? false);
  const [saving, setSaving] = useState(false);
  const [authorizationStatuses, setAuthorizationStatuses] =
    useState<PlatformAuthorizationStatuses>({});

  const handleAuthorizationStatuses = useCallback(
    (statuses: PlatformAuthorizationStatuses) =>
      setAuthorizationStatuses(statuses),
    [],
  );

  useEffect(() => {
    if (!settings) void load();
  }, [settings, load]);

  const changeDirectory = (path: string) => {
    validationId.current += 1;
    setDir(path);
    setDirState({ checking: false, valid: null, message: null });
  };

  const validate = async (path = dir) => {
    const id = ++validationId.current;
    setDirState({ checking: true, valid: null, message: null });
    try {
      await validateDirectory(path.trim());
      if (id !== validationId.current) return;
      setDirState({ checking: false, valid: true, message: null });
    } catch (e) {
      if (id !== validationId.current) return;
      setDirState({
        checking: false,
        valid: false,
        message:
          e instanceof ApiError ? describeError(e.code, e.message) : "校验失败",
      });
    }
  };

  const finish = async () => {
    setSaving(true);
    try {
      await updateSettings({
        recordingDirectory: dir.trim(),
        maxConcurrentRecordings: concurrency,
        quality,
        autoRecord,
      });
      await useServiceStore.getState().fetchStatus();
      message.success("设置已保存");
      navigate("/monitor", { replace: true });
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
      );
    } finally {
      setSaving(false);
    }
  };

  const canNext =
    step === 0 ? dirState.valid === true : step === 1 ? concurrency >= 1 : true;

  return (
    <main className="lr-setup-page">
      <header className="lr-setup-brand" aria-label="直播录制台">
        <img src="/icon1.png" alt="" draggable={false} />
        <span>直播录制台</span>
      </header>
      <Card className="lr-setup-card" title="首次设置">
        <Steps
          current={step}
          items={[
            { title: "保存目录" },
            { title: "录制设置" },
            { title: "平台授权" },
            { title: "完成" },
          ]}
          style={{ marginBottom: 32 }}
        />
        {step === 0 && (
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Typography.Text>选择录像保存目录：</Typography.Text>
            <Space.Compact style={{ width: "100%" }}>
              <Input
                placeholder="输入保存路径，或点击浏览选择目录"
                value={dir}
                onChange={(e) => changeDirectory(e.target.value)}
                onPressEnter={() => void validate()}
              />
              <Button onClick={() => setPickerOpen(true)}>浏览…</Button>
              <Button
                type="primary"
                loading={dirState.checking}
                disabled={!dir.trim()}
                onClick={() => void validate()}
              >
                校验
              </Button>
            </Space.Compact>
            {dirState.valid === true && (
              <Typography.Text type="success">目录可用</Typography.Text>
            )}
            {dirState.valid === false && (
              <Typography.Text type="danger">
                {dirState.message ?? "目录不可用"}
              </Typography.Text>
            )}
            <DirectoryPicker
              open={pickerOpen}
              initialPath={dir.trim() || undefined}
              onClose={() => setPickerOpen(false)}
              onPick={(path) => {
                changeDirectory(path);
                void validate(path);
              }}
            />
          </Space>
        )}
        {step === 1 && (
          <Space orientation="vertical" style={{ width: "100%" }} size="middle">
            <Typography.Text style={{ fontWeight: "bold" }}>
              最大同时录制的直播间数量：
            </Typography.Text>
            <InputNumber
              min={1}
              max={8}
              value={concurrency}
              onChange={(v) => setConcurrency(v ?? 2)}
            />
            <hr />
            <Typography.Text style={{ fontWeight: "bold" }}>
              默认录制清晰度：
            </Typography.Text>
            <Select<Quality>
              aria-label="录制清晰度"
              value={quality}
              onChange={setQuality}
              options={qualityOptions}
              style={{ width: "100%", maxWidth: 320 }}
            />
            <Typography.Text type="secondary">
              默认原画，可在设置中修改。若直播间未提供所选画质，将按实际可用画质录制。
            </Typography.Text>
            <hr />
            <Typography.Text style={{ fontWeight: "bold" }}>
              检测到开播自动录制
            </Typography.Text>
            <Switch
              aria-label="检测到开播自动录制"
              checked={autoRecord}
              onChange={setAutoRecord}
            />
          </Space>
        )}
        {step === 2 && (
          <Space orientation="vertical" style={{ width: "100%" }} size="middle">
            <Typography.Text>
              登录平台账号即可开启对应的观看与录制能力，也可以稍后在设置中完成。
            </Typography.Text>
            <Typography.Text type="danger">
              若需要观看、录制抖音直播，请先进行抖音的授权。
            </Typography.Text>
            <PlatformAuthorizationList
              settings={settings}
              onAuthorized={load}
              onStatusesChange={handleAuthorizationStatuses}
            />
          </Space>
        )}
        {step === 3 && (
          <Space orientation="vertical">
            <Typography.Text>配置确认：</Typography.Text>
            <Typography.Paragraph>
              保存目录：<Typography.Text code>{dir}</Typography.Text>
              <br />
              并发数：{concurrency}
              <br />
              清晰度：
              {qualityOptions.find((option) => option.value === quality)?.label}
              <br />
              自动录制：{autoRecord ? "开启" : "关闭"}
              <br />
              抖音授权：
              {authorizationStatuses.douyin === "authorized"
                ? "已登录"
                : "未登录"}
              <br />
              B站授权：
              {authorizationStatuses.bilibili === "authorized"
                ? "已登录"
                : "未登录"}
            </Typography.Paragraph>
          </Space>
        )}
        <div className="lr-setup-actions">
          <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
            上一步
          </Button>
          {step < 3 ? (
            <Button
              type="primary"
              disabled={!canNext}
              onClick={() => setStep(step + 1)}
            >
              下一步
            </Button>
          ) : (
            <Button
              type="primary"
              loading={saving}
              onClick={() => void finish()}
            >
              完成设置
            </Button>
          )}
        </div>
      </Card>
      <br />
      <Typography.Text>以上设置内容可随时在设置中调整</Typography.Text>
    </main>
  );
}
