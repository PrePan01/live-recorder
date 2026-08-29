import { useEffect, useRef, useState } from 'react';
import { App, Input, List, Segmented, Space, Typography } from 'antd';
import type { InputRef } from 'antd';
import { useNavigate } from 'react-router-dom';
import { searchGlobal } from '../api/search';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';
import { formatRelative } from '../utils/format';
import type { SearchItem, SearchItemType } from '../types/search';

const TYPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'room', label: '房间' },
  { value: 'recording', label: '录像' },
  { value: 'alert', label: '告警' },
];

function itemTitle(item: SearchItem): string {
  if (item.type === 'recording') return item.extra?.roomName ? `${String(item.extra.roomName)} · ${item.title}` : item.title;
  return item.title;
}

export default function GlobalSearch() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [type, setType] = useState<'all' | SearchItemType>('all');
  const [results, setResults] = useState<SearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const kw = q.trim();
    if (kw.length < 1) {
      setResults([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void searchGlobal({ q: kw, type, page: 1, pageSize: 10 })
        .then((res) => {
          setResults(res.items);
          setTotal(res.total);
          setActiveIdx(0);
        })
        .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '搜索失败'))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, type, open, message]);

  const goTo = (item: SearchItem) => {
    setOpen(false);
    setQ('');
    if (item.type === 'room') navigate(`/rooms?focus=${item.id}`);
    else if (item.type === 'recording') navigate(`/history?focus=${item.id}`);
    else navigate('/settings');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[activeIdx]) {
      e.preventDefault();
      goTo(results[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQ('');
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  return (
    <div style={{ position: 'relative', width: 280 }} onKeyDown={onKeyDown}>
      <Input.Search
        ref={inputRef}
        allowClear
        placeholder="搜索房间 / 录像 / 告警"
        value={q}
        loading={loading}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open ? (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            zIndex: 1000,
            background: 'var(--lr-surface)',
            border: '1px solid var(--lr-border)',
            borderRadius: 8,
            boxShadow: 'var(--lr-shadow)',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--lr-border)' }}>
            <Segmented
              size="small"
              options={TYPE_OPTIONS}
              value={type}
              onChange={(v) => setType(v as 'all' | SearchItemType)}
              block
            />
          </div>
          {q.trim().length < 1 ? (
            <Typography.Paragraph type="secondary" style={{ padding: '12px', margin: 0 }}>
              输入关键词开始搜索
            </Typography.Paragraph>
          ) : (
            <div ref={listRef} style={{ maxHeight: 320, overflow: 'auto' }}>
              <List
                size="small"
                loading={loading}
                dataSource={results}
                locale={{ emptyText: total > 0 ? '无匹配结果' : '未找到相关内容' }}
                renderItem={(item, i) => (
                  <List.Item
                    data-idx={i}
                    style={{
                      cursor: 'pointer',
                      padding: '6px 12px',
                      background: i === activeIdx ? 'var(--lr-hover-bg)' : 'transparent',
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goTo(item)}
                  >
                    <List.Item.Meta
                      title={
                        <Typography.Text strong ellipsis style={{ maxWidth: 220 }}>
                          {itemTitle(item)}
                        </Typography.Text>
                      }
                      description={
                        <Space size={8} wrap>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {item.type === 'room' ? '房间' : item.type === 'recording' ? '录像' : '告警'}
                          </Typography.Text>
                          {item.occurredAt ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {formatRelative(item.occurredAt)}
                            </Typography.Text>
                          ) : null}
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
              {total > results.length ? (
                <Typography.Paragraph type="secondary" style={{ padding: '4px 12px 8px', margin: 0, fontSize: 12 }}>
                  共 {total} 条，↑↓ 选择 · Enter 跳转
                </Typography.Paragraph>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}