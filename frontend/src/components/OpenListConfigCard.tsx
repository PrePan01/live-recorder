import { useEffect, useState } from "react";
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
import { ApiError } from "../types/error";

export default function OpenListConfigCard() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Awaited<
    ReturnType<typeof fetchOpenListConfig>
  > | null>(null);
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);
  const [deleteSourceAfterUpload, setDeleteSourceAfterUpload] = useState(false);

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

  const save = (values: Record<string, unknown>) => {
    const { token, ...rest } = values;
    void updateOpenListConfig({
      ...(rest as object),
      ...(typeof token === "string" && token.length > 0 ? { token } : {}),
    })
      .then((c) => setConfig(c))
      .catch((e) =>
        message.error(
          e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
        ),
      );
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
      onValuesChange={(_, all) => save(all)}
    >
      <Form.Item
        label="启用自动上传"
        name="enabled"
        valuePropName="checked"
        extra="管线完成后自动上传到 OpenList（WebDAV）"
      >
        <Switch />
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
          令牌仅存本机，永不回显。
        </Typography.Text>
      </Space>
    </Form>
  );
}
