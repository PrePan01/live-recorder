import { useEffect, useState } from 'react';
import { App, Button, Form, Modal, Popconfirm, Select, Space, Switch, Table, TimePicker, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { createSchedule, deleteSchedule, fetchSchedules, updateSchedule } from '../api/schedule';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';
import { formatTime } from '../utils/format';
import type { RecordingSchedule, ScheduleInput } from '../types/schedule';

const DAYS = [
  { value: 0, label: '周日' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
];

export default function SchedulePanel({ roomId }: { roomId: string }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<RecordingSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<RecordingSchedule | null>(null);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      setItems(await fetchSchedules(roomId));
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '计划加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [roomId]);

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ daysOfWeek: [1], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    setModalOpen(true);
  };

  const openEdit = (s: RecordingSchedule) => {
    setEditing(s);
    form.setFieldsValue({
      daysOfWeek: s.daysOfWeek,
      startTime: dayjs(`2000-01-01T${s.startTime}`),
      endTime: s.endTime ? dayjs(`2000-01-01T${s.endTime}`) : null,
      timezone: s.timezone,
      enabled: s.enabled,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const input: ScheduleInput = {
      daysOfWeek: values.daysOfWeek,
      startTime: values.startTime.format('HH:mm'),
      endTime: values.endTime ? values.endTime.format('HH:mm') : null,
      timezone: values.timezone,
      enabled: values.enabled ?? true,
    };
    try {
      if (editing) {
        await updateSchedule(roomId, editing.id, input);
        message.success('计划已更新');
      } else {
        await createSchedule(roomId, input);
        message.success('计划已创建');
      }
      setModalOpen(false);
      void load();
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '保存失败');
    }
  };

  const toggle = async (s: RecordingSchedule, enabled: boolean) => {
    try {
      await updateSchedule(roomId, s.id, {
        daysOfWeek: s.daysOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        timezone: s.timezone,
        enabled,
      });
      void load();
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '操作失败');
    }
  };

  const columns: ColumnsType<RecordingSchedule> = [
    {
      title: '周期',
      dataIndex: 'daysOfWeek',
      width: 160,
      render: (days: number[]) => days.map((d) => DAYS.find((x) => x.value === d)?.label).join('、'),
    },
    { title: '开始', dataIndex: 'startTime', width: 80 },
    { title: '结束', dataIndex: 'endTime', width: 80, render: (v: string | null) => v ?? '无' },
    { title: '时区', dataIndex: 'timezone', width: 130, ellipsis: true },
    {
      title: '下次执行',
      dataIndex: 'nextRunAt',
      width: 150,
      render: (v: string | null) => (v ? formatTime(v) : '-'),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 70,
      render: (v: boolean, s) => <Switch checked={v} onChange={(c) => void toggle(s, c)} />,
    },
    {
      title: '操作',
      width: 120,
      render: (_, s) => (
        <Space size={0}>
          <Button size="small" type="link" onClick={() => openEdit(s)}>
            编辑
          </Button>
          <Popconfirm title="删除该计划？" onConfirm={() => void deleteSchedule(roomId, s.id).then(() => void load()).catch((e) => message.error(describeError(e.code, e.message)))}>
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
      <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text type="secondary">计划到点触发一次检测，离线不建空录制；跨天窗口以开始时间触发。</Typography.Text>
        <Button size="small" onClick={openAdd}>
          新增计划
        </Button>
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 800 }}
        pagination={false}
        locale={{ emptyText: '暂无定时计划' }}
      />
      <Modal
        title={editing ? '编辑计划' : '新增计划'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label="每周重复" name="daysOfWeek" rules={[{ required: true, message: '至少选一天' }]}>
            <Select mode="multiple" options={DAYS} placeholder="选择星期" />
          </Form.Item>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item label="开始时间" name="startTime" rules={[{ required: true, message: '必填' }]}>
              <TimePicker format="HH:mm" />
            </Form.Item>
            <Form.Item label="结束时间（可选）" name="endTime">
              <TimePicker format="HH:mm" />
            </Form.Item>
          </Space>
          <Form.Item label="时区" name="timezone" extra="默认本机时区；结束早于开始视为跨天">
            <Select
              showSearch
              options={Intl.supportedValuesOf?.('timeZone')?.map((tz) => ({ value: tz, label: tz })) ?? []}
              placeholder="选择时区"
            />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}