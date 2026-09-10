import { useCallback, useEffect, useState } from "react";
import { App, Input, Modal, Space, Typography } from "antd";
import { useUploadStore } from "../stores/uploadStore";
import { fetchUploads, submitOpenList2fa } from "../api/openlist";
import { ApiError } from "../types/error";
import { describeError } from "../utils/errorMap";

/** 上传任务错误中标记 OpenList 需要 2FA 验证（BE #13 契约）。 */
const OPENLIST_2FA_MARKER = "OpenList 需要 2FA 验证";

/** 全局 OpenList 2FA 一次性码弹窗：任一上传任务带「需要 2FA 验证」标记即弹出（#13）。
 * 挂在 App 根部，随 SSE upload:updated 实时更新，不受当前页面限制。 */
export default function OpenList2faModal() {
  const { message } = App.useApp();
  const jobs = useUploadStore((s) => s.jobs);
  const setJobs = useUploadStore((s) => s.setJobs);
  const twoFactorPromptVersion = useUploadStore((s) => s.twoFactorPromptVersion);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  const hasPending2fa = jobs.some(
    (j) =>
      (j.status === "failed" || j.status === "queued") &&
      (j.error ?? "").includes(OPENLIST_2FA_MARKER),
  );

  // 挂载时拉取一次当前上传任务，确保启动前已存在的 2FA 失败任务也能触发弹窗（SSE 仅推送新变更）。
  useEffect(() => {
    let disposed = false;
    void fetchUploads(100)
      .then((list) => {
        if (!disposed) setJobs(list);
      })
      .catch(() => {
        /* 忽略 */
      });
    return () => {
      disposed = true;
    };
  }, [setJobs]);

  // 任一任务出现 2FA 标记 → 弹窗。关闭后，重试同一个任务不会改变
  // 其 2FA 错误，因此还要监听显式的重试提示版本以再次打开弹窗。
  useEffect(() => {
    if (hasPending2fa) setOpen(true);
  }, [hasPending2fa, twoFactorPromptVersion]);

  const handleSubmit = useCallback(
    async (otpCode: string) => {
      if (!otpCode.trim()) {
        message.warning("请输入 2FA 一次性验证码");
        return;
      }
      setBusy(true);
      try {
        await submitOpenList2fa(otpCode.trim());
        setOpen(false);
        setCode("");
        message.success("2FA 验证成功，正在恢复上传任务");
      } catch (e) {
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "2FA 验证失败",
        );
      } finally {
        setBusy(false);
      }
    },
    [message],
  );

  return (
    <Modal
      title="OpenList 自动上传需要两步验证"
      open={open}
      onCancel={() => setOpen(false)}
      onOk={() => void handleSubmit(code)}
      confirmLoading={busy}
      okText="验证并恢复上传"
      cancelText="取消"
      destroyOnHidden
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          OpenList 账号已开启两步验证（2FA）。请在输入验证器应用中获取的验证码。
        </Typography.Text>
        <Input.Password
          placeholder="6 位验证码"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onPressEnter={() => void handleSubmit(code)}
          autoFocus
          maxLength={12}
        />
      </Space>
    </Modal>
  );
}
