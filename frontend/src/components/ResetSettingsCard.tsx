import { useState } from 'react';
import { App, Alert, Button, Card, Checkbox, Modal, Space, Typography } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { resetApplication } from '../api/settings';

interface ResetSettingsCardProps {
  onExport: () => Promise<void>;
  exporting: boolean;
  beforeReset: () => void;
}

function finishReset() {
  for (const key of ['lr-wall-store', 'lr-monitor-view', 'lr-fatal-error', 'lr-react-mounted', 'live-recorder-theme']) {
    localStorage.removeItem(key);
  }
  window.location.reload();
}

export default function ResetSettingsCard({ onExport, exporting, beforeReset }: ResetSettingsCardProps) {
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false);
  const [keepRecordings, setKeepRecordings] = useState(true);
  const [resetting, setResetting] = useState(false);

  const confirmReset = async () => {
    if (resetting || exporting) return;
    setResetting(true);
    beforeReset();
    try {
      const result = await resetApplication(keepRecordings);
      if (result.retainedFiles.length > 0) {
        setOpen(false);
        modal.warning({
          title: '数据已重置，部分录像文件未能删除',
          content: <div>以下临时文件仍在磁盘中，可手动清理：{result.retainedFiles.map((file) => <div key={file} style={{ overflowWrap: 'anywhere' }}>{file}</div>)}</div>,
          okText: '返回初始设置',
          onOk: finishReset,
        });
      } else {
        finishReset();
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重置失败，请重试');
      setResetting(false);
    }
  };

  return (
    <>
      <Card title="重置应用" style={{ marginTop: 16 }}>
        <Space orientation="vertical">
          <Typography.Text type="secondary">清空应用数据与凭证，恢复至初始设置。此操作无法撤销。</Typography.Text>
          <Button danger icon={<ReloadOutlined />} onClick={() => { setKeepRecordings(true); setOpen(true); }}>
            重置
          </Button>
        </Space>
      </Card>
      <Modal
        title="确认重置应用"
        open={open}
        okText="确认重置"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: exporting }}
        confirmLoading={resetting}
        cancelButtonProps={{ disabled: resetting }}
        closable={!resetting}
        keyboard={!resetting}
        maskClosable={!resetting}
        onCancel={() => { if (!resetting) setOpen(false); }}
        onOk={() => void confirmReset()}
      >
        <Space orientation="vertical" size={20} style={{ width: '100%' }}>
          <Alert type="warning" showIcon title="将清空所有房间、录制历史、标签、定时计划、任务记录、告警、设置与凭证，并恢复界面偏好。" />
          <Space wrap>
            <Typography.Text>是否备份配置数据</Typography.Text>
            <Button icon={<DownloadOutlined />} loading={exporting} disabled={resetting} onClick={() => void onExport()}>导出</Button>
          </Space>
          <Typography.Text type="secondary">导出包含当前配置、房间与告警，不包含录像、历史记录或密码/Cookie/令牌。凭证恢复后需重新填写。</Typography.Text>
          <Checkbox checked={keepRecordings} disabled={resetting} onChange={(event) => setKeepRecordings(event.target.checked)}>
            <Typography.Text type="danger">是否保留录像文件</Typography.Text>
          </Checkbox>
          <Typography.Text type={keepRecordings ? 'secondary' : 'danger'}>
            {keepRecordings
              ? '保留本地录像文件，但应用内的录制历史仍会清空。'
              : '不保留：同时删除应用记录关联的本地录像及后处理文件，不删除远端上传文件或独立导出的备份。'}
          </Typography.Text>
          <Typography.Text type="secondary">请先结束录制、转码、上传和导出任务，再确认重置。</Typography.Text>
        </Space>
      </Modal>
    </>
  );
}
