import { useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Popconfirm, Space, Switch, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useRoomStore } from '../../stores/roomStore';
import { MonitorStateTag, PlatformTag } from '../../components/StatusTags';
import type { Room } from '../../types/room';
import { ApiError } from '../../types/error';
import { describeError } from '../../utils/errorMap';
import { formatRelative } from '../../utils/format';

function guessPlatform(url: string): string | null {
  if (/live\.douyin\.com|douyin\.com/.test(url)) return '抖音';
  if (/live\.bilibili\.com|bilibili\.com/.test(url)) return 'B站';
  return null;
}

export default function Rooms() {
  const { message } = App.useApp();
  const { rooms, loading, fetchRooms, addRoom, editRoom, removeRoom, toggleRoom } = useRoomStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ url: string; displayName?: string }>();

  useEffect(() => {
    void fetchRooms().catch(() => message.error('房间列表加载失败'));
  }, [fetchRooms, message]);

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (room: Room) => {
    setEditing(room);
    form.setFieldsValue({ url: room.url, displayName: room.displayName });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      if (editing) {
        await editRoom(editing.id, values);
        message.success('房间已更新');
      } else {
        await addRoom(values);
        message.success('房间已添加');
      }
      setModalOpen(false);
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const urlValue = Form.useWatch('url', form);

  const columns: ColumnsType<Room> = [
    { title: '平台', dataIndex: 'platform', width: 90, render: (p) => <PlatformTag platform={p} /> },
    { title: '显示名', dataIndex: 'displayName', ellipsis: true },
    {
      title: '链接',
      dataIndex: 'url',
      ellipsis: true,
      render: (u: string) => (
        <Typography.Link copyable={{ text: u }} href={u} target="_blank">
          {u}
        </Typography.Link>
      ),
    },
    { title: '状态', dataIndex: 'monitorState', width: 100, render: (s) => <MonitorStateTag state={s} /> },
    {
      title: '最近错误',
      dataIndex: 'lastError',
      width: 180,
      ellipsis: true,
      render: (e: Room['lastError']) => (e ? <Typography.Text type="danger">{e.message}</Typography.Text> : '-'),
    },
    { title: '最近检测', dataIndex: 'lastCheckedAt', width: 110, render: (t) => formatRelative(t) },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 70,
      render: (v: boolean, room) => (
        <Switch
          checked={v}
          onChange={(checked) =>
            void toggleRoom(room.id, checked).catch((e) =>
              message.error(e instanceof ApiError ? describeError(e.code, e.message) : '操作失败'),
            )
          }
        />
      ),
    },
    {
      title: '操作',
      width: 130,
      render: (_, room) => (
        <Space>
          <Button size="small" type="link" onClick={() => openEdit(room)}>
            编辑
          </Button>
          <Popconfirm
            title="删除后不可恢复，确定？"
            onConfirm={() => void removeRoom(room.id).catch(() => message.error('删除失败'))}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          直播间管理
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
          添加直播间
        </Button>
      </Space>
      <Table rowKey="id" columns={columns} dataSource={rooms} loading={loading} pagination={false} />
      <Modal
        title={editing ? '编辑直播间' : '添加直播间'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="url"
            label="直播链接"
            rules={[
              { required: true, message: '请输入直播链接' },
              {
                validator: (_, v: string) =>
                  !v || guessPlatform(v) ? Promise.resolve() : Promise.reject(new Error('仅支持 B站 / 抖音 直播链接')),
              },
            ]}
            extra={urlValue && guessPlatform(urlValue) ? `识别为：${guessPlatform(urlValue)}` : undefined}
          >
            <Input placeholder="https://live.bilibili.com/... 或 https://live.douyin.com/..." />
          </Form.Item>
          <Form.Item name="displayName" label="显示名（可选，留空自动解析）">
            <Input placeholder="主播昵称" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
