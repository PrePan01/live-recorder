import { useCallback, useEffect, useState } from 'react';
import { App, Input, Modal, Space, Typography } from 'antd';
import { useUploadStore } from '../stores/uploadStore';
import { fetchUploads, retryUpload, submitOpenList2fa } from '../api/openlist';
import { ApiError } from '../types/error';
import { describeError } from '../utils/errorMap';

/** 上传任务错误中标记 OpenList 需要 2FA 验证（BE #13 契约）。 */
const OPENLIST_2FA_MARKER = 'OpenList 需要 2FA 验证';

/** 全局 OpenList 2FA 一次性码弹窗：任一上传任务带「需要 2FA 验证」标记即弹出（#13）。
 * 挂在 App 根部，随 SSE upload:updated 实时更新，不受当前页面限制。 */
export default function OpenList2faModal() {
  const { message } = App.useApp();
  const jobs = useUploadStore((s) => s.jobs);
  const setJobs = useUploadStore((s) => s.setJobs);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');

  const hasPending2fa = jobs.some((j) => (j.status === 'failed' || j.status === 'queued') && (j.error ?? '').includes(OPENLIST_2FA_MARKER));

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

  // 任一任务出现 2FA 标记 → 弹窗（全局，仅弹一次）。
  useEffect(() => {
    if (hasPending2fa) setOpen(true);
  }, [hasPending2fa]);

  const handleSubmit = useCallback(
    async (otpCode: string) => {
      if (!otpCode.trim()) {
        message.warning('请输入 2FA 一次性验证码');
        return;
      }
      setBusy(true);
      try {
        await submitOpenList2fa(otpCode.trim());
        setOpen(false);
        setCode('');
        message.success('2FA 验证成功，正在恢复上传任务');
        // 验证成功后自动重试所有 2FA 待定的失败任务。
        try {
          const latest = await fetchUploads(100);
          for (const job of latest.filter((j) => j.status === 'failed' && (j.error ?? '').includes(OPENLIST_2FA_MARKER))) {
            void retryUpload(job.id);
          }
        } catch {
          /* 忽略 */
        }
      } catch (e) {
        message.error(e instanceof ApiError ? describeError(e.code, e.message) : '2FA 验证失败');
      } finally {
        setBusy(false);
      }
    },
    [message],
  );

  return (
    <Modal
      title="OpenList 需要 2FA 验证"
      open={open}
      onCancel={() => setOpen(false)}
      onOk={() => void handleSubmit(code)}
      confirmLoading={busy}
      okText="验证并恢复上传"
      cancelText="取消"
      destroyOnHidden
    >
      <Space orientation="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          OpenList 账号已开启两步验证（2FA）。请在手机验证器中获取一次性验证码并输入，换取短期令牌后自动恢复上传。
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