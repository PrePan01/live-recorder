import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Card, Col, DatePicker, Empty, Row, Select, Space, Statistic, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { fetchRecordingsStats } from '../../api/stats';
import { useRoomStore } from '../../stores/roomStore';
import { useTagStore } from '../../stores/tagStore';
import { describeError } from '../../utils/errorMap';
import { ApiError } from '../../types/error';
import { formatBytes } from '../../utils/format';
import type { RecordingsStats } from '../../types/stats';

const PLATFORM_LABEL: Record<string, string> = { bilibili: 'B站', douyin: '抖音' };

export default function Stats() {
  const { message } = App.useApp();
  const rooms = useRoomStore((s) => s.rooms);
  const fetchRooms = useRoomStore((s) => s.fetchRooms);
  const tags = useTagStore((s) => s.tags);
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>([dayjs().subtract(29, 'day'), dayjs()]);
  const [platform, setPlatform] = useState<string | undefined>();
  const [tagId, setTagId] = useState<string | undefined>();
  const [roomId, setRoomId] = useState<string | undefined>();
  const [stats, setStats] = useState<RecordingsStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q: Record<string, string> = {};
      if (range) {
        q.from = range[0].startOf('day').toISOString();
        q.to = range[1].endOf('day').toISOString();
      }
      if (platform) q.platform = platform;
      if (tagId) q.tagId = tagId;
      if (roomId) q.roomId = roomId;
      setStats(await fetchRecordingsStats(q));
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '统计加载失败');
    } finally {
      setLoading(false);
    }
  }, [range, platform, tagId, roomId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (rooms.length === 0) void fetchRooms().catch(() => undefined);
    if (tags.length === 0) void useTagStore.getState().load().catch(() => undefined);
  }, [rooms.length, tags.length, fetchRooms]);

  const maxDayCount = useMemo(() => Math.max(...stats?.byDay.map((d) => d.recordings) ?? [0], 1), [stats]);

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          统计看板
        </Typography.Title>
        <Space wrap>
          <DatePicker.RangePicker
            value={range}
            onChange={(v) => setRange(v as [Dayjs, Dayjs] | null)}
          />
          <Select
            allowClear
            placeholder="平台"
            style={{ width: 110 }}
            value={platform}
            onChange={setPlatform}
            options={[
              { value: 'bilibili', label: 'B站' },
              { value: 'douyin', label: '抖音' },
            ]}
          />
          <Select
            allowClear
            placeholder="标签"
            style={{ width: 120 }}
            value={tagId}
            onChange={setTagId}
            options={tags.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Select
            allowClear
            placeholder="房间"
            style={{ width: 160 }}
            value={roomId}
            onChange={setRoomId}
            options={rooms.map((r) => ({ value: r.id, label: r.displayName }))}
          />
        </Space>
      </Space>
      {stats ? (
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic title="录制场次" value={stats.totals.recordings} suffix={stats.totals.failed > 0 ? `（失败 ${stats.totals.failed}）` : undefined} />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic title="录制时长" value={Math.round(stats.totals.durationMs / 3600000)} suffix="小时" />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic title="占用空间" value={stats.totals.bytes} formatter={(v) => formatBytes(Number(v))} />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic title="成功率" value={stats.totals.successRate} suffix="%" valueStyle={{ color: stats.totals.successRate >= 80 ? undefined : '#cf1322' }} />
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card title="每日录制趋势" loading={loading}>
              {stats.byDay.length === 0 ? (
                <Empty description="该区间暂无录制数据" />
              ) : (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 160 }}>
                  {stats.byDay.map((d) => (
                    <div key={d.date} style={{ flex: 1, textAlign: 'center' }}>
                      <div
                        style={{
                          height: `${Math.max((d.recordings / maxDayCount) * 120, 2)}px`,
                          background: 'var(--lr-primary)',
                          borderRadius: '3px 3px 0 0',
                          opacity: 0.85,
                        }}
                        title={`${d.date}：${d.recordings} 场，${formatBytes(d.bytes)}`}
                      />
                      <div style={{ fontSize: 10, color: 'var(--lr-text-secondary)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {dayjs(d.date).format('MM-DD')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </Col>
          <Col xs={24} lg={10}>
            <Card title="平台分布" loading={loading}>
              {stats.byPlatform.length === 0 ? (
                <Empty description="暂无平台数据" />
              ) : (
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  {stats.byPlatform.map((p) => (
                    <div key={p.platform}>
                      <Space style={{ width: '100%', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                        <Typography.Text>{PLATFORM_LABEL[p.platform] ?? p.platform}</Typography.Text>
                        <Typography.Text type="secondary">
                          {p.recordings} 场 · {formatBytes(p.bytes)}
                        </Typography.Text>
                      </Space>
                      <div style={{ background: 'var(--lr-border)', borderRadius: 4, height: 8, marginTop: 4 }}>
                        <div
                          style={{
                            width: `${stats.totals.recordings > 0 ? (p.recordings / stats.totals.recordings) * 100 : 0}%`,
                            height: 8,
                            background: 'var(--lr-primary)',
                            borderRadius: 4,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </Space>
              )}
            </Card>
          </Col>
        </Row>
      ) : null}
      {stats ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          数据刷新于 {dayjs(stats.generatedAt).format('YYYY-MM-DD HH:mm:ss')}
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}