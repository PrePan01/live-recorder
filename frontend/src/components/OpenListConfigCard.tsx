import { useEffect, useRef, useState } from "react";
import {
  App,
  Button,
  Form,
  Input,
  Popconfirm,
  Space,
  Switch,
  Typography,
} from "antd";
import {
  fetchOpenListConfig,
  updateOpenListConfig,
  testOpenList,
} from "../api/openlist";
import { describeError } from "../utils/errorMap";
import {
  affectsConnection,
  saveAndVerifyAutoUpload,
} from "../utils/openListAutoUpload";
import { ApiError } from "../types/error";

/** 复检防抖：地址/令牌是逐字符保存的，等输入停下再探测一次。 */
const RECHECK_DEBOUNCE_MS = 800;
/** 自动检测提示共用一个 key，连续编辑时替换而不是叠加。 */
const CHECK_MESSAGE_KEY = "openlist-auto-upload-check";

export default function OpenListConfigCard() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Awaited<
    ReturnType<typeof fetchOpenListConfig>
  > | null>(null);
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [deleteSourceAfterUpload, setDeleteSourceAfterUpload] = useState(false);
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRecheck = () => {
    if (!recheckTimer.current) return;
    clearTimeout(recheckTimer.current);
    recheckTimer.current = null;
  };

  useEffect(() => cancelRecheck, []);

  useEffect(() => {
    fetchOpenListConfig()
      .then((c) => {
        setConfig(c);
        form.setFieldsValue({ ...c, token: "" });
        setDeleteSourceAfterUpload(c.deleteSourceAfterUpload);
      })
      .catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "OpenList 配置加载失败",
        ),
      );
  }, [form, message]);

  const persist = async (values: Record<string, unknown>): Promise<void> => {
    const { token, ...rest } = values;
    const saved = await updateOpenListConfig({
      ...(rest as object),
      ...(typeof token === "string" && token.length > 0 ? { token } : {}),
    });
    setConfig(saved);
  };

  const save = (values: Record<string, unknown>) => {
    void persist(values).catch((e) =>
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
      ),
    );
  };

  // 保存后做一次连接检测，检测不通过会把自动上传关掉（见 openListAutoUpload）。
  const runCheck = async (
    values: Record<string, unknown>,
    successText?: string,
  ) => {
    setChecking(true);
    try {
      const result = await saveAndVerifyAutoUpload(() => persist(values));
      form.setFieldValue("enabled", result.enabled);
      // 同一个 key：连续编辑时提示是替换而不是叠加。
      if (result.error) {
        message.error({ content: result.error, key: CHECK_MESSAGE_KEY });
      } else if (successText) {
        message.success({ content: successText, key: CHECK_MESSAGE_KEY });
      }
    } finally {
      setChecking(false);
    }
  };

  // 开关已开时改动地址/凭证会逐字符触发保存，检测必须等输入停下来再做，否则每个字符探测一次。
  const scheduleRecheck = (values: Record<string, unknown>) => {
    cancelRecheck();
    recheckTimer.current = setTimeout(() => {
      recheckTimer.current = null;
      void runCheck(values);
    }, RECHECK_DEBOUNCE_MS);
  };

  const onValuesChange = (
    changed: Record<string, unknown>,
    all: Record<string, unknown>,
  ) => {
    if (changed.enabled === true) {
      // 开关自己这条路径会检测，作废挂起的复检，避免重复探测。
      cancelRecheck();
      void runCheck(all, "连接正常，已开启自动上传");
      return;
    }
    // 刚关掉开关：挂起的复检不再有意义（否则会弹出无谓的"已自动关闭"提示）。
    if (changed.enabled === false) cancelRecheck();
    save(all);
    if (all.enabled === true && affectsConnection(changed))
      scheduleRecheck(all);
  };

  const onTest = async () => {
    const values = form.getFieldsValue();
    if (!values.serverUrl || !String(values.serverUrl).trim()) {
      message.warning("请先填写服务器地址");
      return;
    }
    const tokenValue =
      typeof values.token === "string" ? values.token.trim() : "";
    if (!config?.hasToken && !tokenValue) {
      message.warning("请先填写令牌");
      return;
    }
    setTesting(true);
    try {
      const res = await testOpenList();
      message.success(res.ok ? "连接成功" : "连接异常");
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "连接失败",
      );
    } finally {
      setTesting(false);
    }
  };

  const saveDeleteSourceAfterUpload = (enabled: boolean) => {
    setDeleteSourceAfterUpload(enabled);
    form.setFieldValue("deleteSourceAfterUpload", enabled);
    save({ ...form.getFieldsValue(), deleteSourceAfterUpload: enabled });
  };

  return (
    <Form
      form={form}
      layout="vertical"
      size="small"
      onValuesChange={onValuesChange}
    >
      <Form.Item label="启用自动上传" name="enabled" valuePropName="checked">
        <Switch loading={checking} />
      </Form.Item>
      <Form.Item label="上传成功后删除本地文件">
        {deleteSourceAfterUpload ? (
          <Switch
            checked
            onChange={(enabled) => {
              if (!enabled) saveDeleteSourceAfterUpload(false);
            }}
          />
        ) : (
          <Popconfirm
            title="确认开启？"
            okText="确认"
            cancelText="取消"
            onConfirm={() => saveDeleteSourceAfterUpload(true)}
          >
            {/* 关闭时 Switch 不接收指针事件，只有确认后才可能改为开启。 */}
            <span
              role="button"
              tabIndex={0}
              style={{ display: "inline-flex" }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.currentTarget.click();
                }
              }}
            >
              <Switch checked={false} style={{ pointerEvents: "none" }} />
            </span>
          </Popconfirm>
        )}
      </Form.Item>
      <Form.Item
        label="服务器地址"
        name="serverUrl"
        rules={[{ required: true, message: "必填" }]}
      >
        <Input placeholder="https://dav.example.com/remote.php/dav/files/user/" />
      </Form.Item>
      <Form.Item
        label="目录模板"
        name="directoryTemplate"
        extra="支持 {room}/{platform}/{date} 等变量"
      >
        <Input placeholder="{platform}/{room}" />
      </Form.Item>
      <Form.Item label="用户名" name="username">
        <Input autoComplete="username" />
      </Form.Item>
      <Form.Item
        label="令牌（WebDAV 密码）"
        name="token"
        extra={config?.hasToken ? "已保存，留空则不修改" : undefined}
      >
        <Input.Password
          placeholder={config?.hasToken ? "••••••" : "输入令牌"}
          autoComplete="new-password"
        />
      </Form.Item>
      <Space>
        <Button size="small" loading={testing} onClick={() => void onTest()}>
          测试连接
        </Button>
        <Typography.Text type="secondary">
          令牌仅保存在本机，不会上传或提供他人。
        </Typography.Text>
      </Space>
    </Form>
  );
}
