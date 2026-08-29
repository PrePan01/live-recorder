import { useEffect, useMemo, useState } from 'react';
import { App, Alert, Button, Drawer, Form, Input, List, Modal, Popconfirm, Popover, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined, StarFilled, StarOutlined, ScheduleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useRoomStore } from '../../stores/roomStore';
import { useTagStore } from '../../stores/tagStore';
import { useResizableColumns } from '../../hooks/useResizableColumns';
import { MonitorStateTag } from '../../components/StatusTags';
import { PlatformLogoTag } from '../../components/PlatformLogo';
import TagSelect from '../../components/TagSelect';
import SchedulePanel from '../../components/SchedulePanel';
import type { Room } from '../../types/room';
import { ApiError } from '../../types/error';
import { describeError } from '../../utils/errorMap';
import { formatRelative } from '../../utils/format';

function guessPlatform(url: string): Room['platform'] | null {
  if (/live\.douyin\.com|douyin\.com/.test(url)) return 'douyin';
  if (/live\.bilibili\.com|bilibili\.com/.test(url)) return 'bilibili';
  return null;
}

const PLATFORM_LABEL: Record<Room['platform'], string> = { bilibili: 'B站', douyin: '抖音' };

export default function Rooms() {
  const { message } = App.useApp();
  const { rooms, loading, fetchRooms, addRoom, batchAddRooms, editRoom, removeRoom, toggleRoom, favoriteRoom, setAutoRecord, updateRoomTags, checkRoomNow } = useRoomStore();
  const tags = useTagStore((s) => s.tags);
  const [modalOpen, setModalOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchBusy2, setBatchBusy2] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchResult, setBatchResult] = useState<Awaited<ReturnType<typeof batchAddRooms>> | null>(null);
  const [editing, setEditing] = useState<Room | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [form] = Form.useForm<{ url: string; displayName?: string }>();
  const [keyword, setKeyword] = useState('');
  const [platform, setPlatform] = useState<string>();
  const [state, setState] = useState<string>();
  const [favOnly, setFavOnly] = useState<boolean>(false);
  const [tagId, setTagId] = useState<string>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [scheduleRoom, setScheduleRoom] = useState<Room | null>(null);

  useEffect(() => {
    void fetchRooms().catch(() => message.error('房间列表加载失败'));
  }, [fetchRooms, message]);

  useEffect(() => {
    void useTagStore.getState().load().catch(() => undefined);
  }, []);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rooms.filter((r) => {
      if (kw && !r.displayName.toLowerCase().includes(kw) && !r.url.toLowerCase().includes(kw)) return false;
      if (platform && r.platform !== platform) return false;
      if (state && r.monitorState !== state) return false;
      if (favOnly && !r.favorited) return false;
      if (tagId && !r.tags.some((t) => t.id === tagId)) return false;
      return true;
    });
  }, [rooms, keyword, platform, state, favOnly, tagId]);

  const paginated = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const focusId = params.get('focus');
    if (!focusId || rooms.length === 0) return;
    const idx = rooms.findIndex((r) => r.id === focusId);
    if (idx === -1) return;
    const targetPage = Math.floor(idx / pageSize) + 1;
    setPage(targetPage);
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-room-id="${focusId}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'background 1s ease';
        el.style.background = 'var(--lr-hover-bg)';
        setTimeout(() => {
          el.style.background = '';
        }, 2000);
      }
    }, 400);
    window.history.replaceState({}, '', '/rooms');
    return () => clearTimeout(timer);
  }, [rooms, pageSize]);

  const resetPage = () => setPage(1);

  const runBatch = async (fn: (r: Room) => Promise<void>, okMsg: string) => {
    const targets = rooms.filter((r) => selectedKeys.includes(r.id));
    if (targets.length === 0) {
      message.warning('请先选择要操作的房间');
      return;
    }
    setBatchBusy(true);
    try {
      await Promise.all(targets.map((r) => fn(r)));
      message.success(`${okMsg} ${targets.length} 个房间`);
      setSelectedKeys([]);
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '批量操作失败');
    } finally {
      setBatchBusy(false);
    }
  };

  const batchActions = (
    <Space>
      <Button
        size="small"
        disabled={batchBusy || selectedKeys.length === 0}
        onClick={() =>
          void runBatch((r) => toggleRoom(r.id, true), '已启用')
        }
      >
        批量启用
      </Button>
      <Button
        size="small"
        disabled={batchBusy || selectedKeys.length === 0}
        onClick={() =>
          void runBatch((r) => toggleRoom(r.id, false), '已停用')
        }
      >
        批量停用
      </Button>
      <Popconfirm
        title={`确定删除所选 ${selectedKeys.length} 个房间？不可恢复。`}
        onConfirm={() => void runBatch((r) => removeRoom(r.id), '已删除')}
      >
        <Button size="small" danger disabled={batchBusy || selectedKeys.length === 0}>
          批量删除
        </Button>
      </Popconfirm>
    </Space>
  );

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    setTagIds([]);
    setModalOpen(true);
  };

  const openEdit = (room: Room) => {
    setEditing(room);
    form.setFieldsValue({ url: room.url, displayName: room.displayName });
    setTagIds(room.tags.map((t) => t.id));
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const platform = guessPlatform(values.url);
    if (!platform) {
      message.error('仅支持 B站 / 抖音 直播链接');
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await editRoom(editing.id, values);
        if (tagIds.length > 0 || editing.tags.length > 0) {
          await updateRoomTags(editing.id, tagIds);
        }
        message.success('房间已更新');
      } else {
        const room = await addRoom({ ...values, platform });
        message.success('房间已添加，正在识别显示名…');
        // 添加后立即检测，让显示名/直播状态即时解析（不必等调度器最长 120s）。
        void checkRoomNow(room.id).catch(() => undefined);
      }
      setModalOpen(false);
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const urlValue = Form.useWatch('url', form);

  const submitBatch = async () => {
    const urls = batchText.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (urls.length === 0) {
      message.warning('请粘贴至少一行直播链接');
      return;
    }
    setBatchBusy2(true);
    setBatchResult(null);
    try {
      const res = await batchAddRooms(urls);
      setBatchResult(res);
      message.success(`成功 ${res.succeeded.length} 条，失败 ${res.failed.length} 条`);
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '批量添加失败');
    } finally {
      setBatchBusy2(false);
    }
  };

  const columns: ColumnsType<Room> = [
    {
      title: '收藏',
      dataIndex: 'favorited',
      width: 70,
      render: (v: boolean, room) => (
        <Button
          type="text"
          size="small"
          icon={v ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
          onClick={() =>
            void favoriteRoom(room.id, !v).catch((e) =>
              message.error(e instanceof ApiError ? describeError(e.code, e.message) : '操作失败'),
            )
          }
        />
      ),
    },
    { title: '平台', dataIndex: 'platform', width: 90, render: (p) => <PlatformLogoTag platform={p} /> },
    {
      title: '自动录制',
      dataIndex: 'autoRecord',
      width: 130,
      render: (v: boolean | null, room) => (
        <Select
          size="small"
          value={v === null ? 'inherit' : v ? 'on' : 'off'}
          style={{ width: 112 }}
          onChange={(val) =>
            void setAutoRecord(room.id, val === 'inherit' ? null : val === 'on')
              .then(() => message.success(val === 'inherit' ? '已恢复跟随全局' : `已${val === 'on' ? '开启' : '关闭'}`))
              .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '操作失败'))
          }
          options={[
            { value: 'inherit', label: '跟随全局' },
            { value: 'on', label: '开启' },
            { value: 'off', label: '关闭' },
          ]}
        />
      ),
    },
    { title: '显示名', dataIndex: 'displayName', width: 160, ellipsis: true, render: (v: string, r) => (
        <Space size={4}>
          <span>{v}</span>
          {r.titleFallbackUsed ? (
            <Tooltip title="回退/占位标题，平台接口未返回正式标题">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                （回退）
              </Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
      ) },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 160,
      render: (ts: Room['tags']) =>
        ts.length === 0 ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : (
          <Space size={[4, 4]} wrap>
            {ts.map((t) => (
              <Tag key={t.id} color={t.color} style={{ marginInlineEnd: 0 }}>
                {t.name}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '链接',
      dataIndex: 'url',
      width: 220,
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
      fixed: 'right' as const,
      render: (_, room) => (
        <Space>
          <Button size="small" type="link" onClick={() => openEdit(room)}>
            编辑
          </Button>
          <Button size="small" type="link" icon={<ScheduleOutlined />} onClick={() => setScheduleRoom(room)}>
            计划
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

  const { columns: resizedColumns, components: resizableComponents } = useResizableColumns<Room>(columns);

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          直播间管理
        </Typography.Title>
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={() => { setBatchOpen(true); }}>
            批量添加
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
            添加直播间
          </Button>
        </Space>
      </Space>
      <Space style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <Input.Search
          allowClear
          placeholder="搜索显示名 / 链接"
          style={{ width: 220 }}
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            resetPage();
          }}
        />
        <Select
          allowClear
          placeholder="平台"
          style={{ width: 110 }}
          value={platform}
          onChange={(v) => {
            setPlatform(v);
            resetPage();
          }}
          options={[
            { value: 'bilibili', label: 'B站' },
            { value: 'douyin', label: '抖音' },
          ]}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 130 }}
          value={state}
          onChange={(v) => {
            setState(v);
            resetPage();
          }}
          options={[
            { value: 'idle', label: '空闲' },
            { value: 'checking', label: '检测中' },
            { value: 'recording', label: '录制中' },
            { value: 'reconnecting', label: '重连中' },
            { value: 'completed', label: '已完成' },
            { value: 'failed', label: '失败' },
            { value: 'disabled', label: '已停用' },
          ]}
        />
        <Select
          allowClear
          placeholder="标签"
          style={{ width: 120 }}
          value={tagId}
          onChange={(v) => {
            setTagId(v);
            resetPage();
          }}
          options={tags.map((t) => ({ value: t.id, label: t.name }))}
        />
        <Button
          type={favOnly ? 'primary' : 'default'}
          icon={<StarOutlined />}
          onClick={() => {
            setFavOnly((v) => !v);
            resetPage();
          }}
        >
          仅看收藏
        </Button>
        <Popover content={batchActions} trigger="click" placement="bottom">
          <Button disabled={selectedKeys.length === 0}>批量操作</Button>
        </Popover>
        {selectedKeys.length > 0 ? <Typography.Text type="secondary">已选 {selectedKeys.length} 项</Typography.Text> : null}
      </Space>
      <Table
        rowKey="id"
        columns={resizedColumns}
        components={resizableComponents}
        dataSource={paginated}
        loading={loading}
        scroll={{ x: 1420 }}
        onRow={(r) => ({ 'data-room-id': r.id } as React.HTMLAttributes<HTMLElement>)}
        rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
        pagination={{
          current: page,
          pageSize,
          total: filtered.length,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50],
          showTotal: (t) => `共 ${t} 个房间`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
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
            extra={urlValue && guessPlatform(urlValue) ? `识别为：${PLATFORM_LABEL[guessPlatform(urlValue)!]}` : undefined}
          >
            <Input placeholder="https://live.bilibili.com/... 或 https://live.douyin.com/..." />
          </Form.Item>
          <Form.Item name="displayName" label="显示名（可选，留空自动解析）">
            <Input placeholder="主播昵称" />
          </Form.Item>
          {editing ? (
            <Form.Item label="标签" extra="单房间最多 20 个；在弹层内可创建/删除标签">
              <TagSelect value={tagIds} onChange={setTagIds} />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>
      <Modal
        title="批量添加直播间"
        open={batchOpen}
        onCancel={() => {
          setBatchOpen(false);
          setBatchResult(null);
          setBatchText('');
        }}
        onOk={() => void submitBatch()}
        confirmLoading={batchBusy2}
        okText="批量添加"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          每行一个直播链接，支持 B站 / 抖音 混排，最多 100 条。自动去重（含已存在房间与批内重复）。
        </Typography.Paragraph>
        <Input.TextArea
          rows={6}
          placeholder={'https://live.bilibili.com/...\nhttps://live.douyin.com/...'}
          value={batchText}
          onChange={(e) => setBatchText(e.target.value)}
        />
        {batchResult ? (
          <div style={{ marginTop: 12 }}>
            {batchResult.failed.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`失败 ${batchResult.failed.length} 条`}
                description={
                  <List
                    size="small"
                    dataSource={batchResult.failed}
                    renderItem={(f) => (
                      <List.Item>
                        <Typography.Text type="secondary" ellipsis style={{ maxWidth: 260 }}>
                          {f.url}
                        </Typography.Text>
                        <Typography.Text type="danger">{f.reason}</Typography.Text>
                      </List.Item>
                    )}
                  />
                }
              />
            ) : (
              <Alert type="success" showIcon message={`全部成功（${batchResult.succeeded.length} 条）`} />
            )}
          </div>
        ) : null}
      </Modal>
    <Drawer
        title={`定时计划：${scheduleRoom?.displayName ?? ''}`}
        open={scheduleRoom !== null}
        width={720}
        onClose={() => setScheduleRoom(null)}
      >
        {scheduleRoom ? <SchedulePanel roomId={scheduleRoom.id} /> : null}
      </Drawer>
    </div>
  );
}
