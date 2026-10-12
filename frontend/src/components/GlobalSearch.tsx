import { useEffect, useRef, useState } from "react";
import { App, Input, List, Segmented, Space, Typography } from "antd";
import type { InputRef } from "antd";
import { useNavigate } from "react-router-dom";
import { searchGlobal } from "../api/search";
import { describeError } from "../utils/errorMap";
import { ApiError } from "../types/error";
import { formatRelative } from "../utils/format";
import type { SearchItem, SearchItemType } from "../types/search";

const TYPE_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "room", label: "房间" },
  { value: "recording", label: "录像" },
  { value: "alert", label: "告警" },
];

function itemTitle(item: SearchItem): string {
  if (item.type === "recording")
    return item.extra?.roomName
      ? `${String(item.extra.roomName)} · ${item.title}`
      : item.title;
  return item.title;
}

export default function GlobalSearch() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [type, setType] = useState<"all" | SearchItemType>("all");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const searchVersion = useRef(0);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (q) setOpen(true);
  }, [q]);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      return;
    }
    requestRef.current?.abort();
    const kw = q.trim();
    if (kw.length < 1) {
      setResults([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    const version = ++searchVersion.current;
    const timer = setTimeout(() => {
      const controller = new AbortController();
      requestRef.current = controller;
      void searchGlobal({
        q: kw,
        type,
        page: 1,
        pageSize: 10,
        signal: controller.signal,
      })
        .then((res) => {
          if (version !== searchVersion.current) return;
          setResults(res.items);
          setTotal(res.total);
          setActiveIdx(0);
        })
        .catch((e) => {
          if (controller.signal.aborted || version !== searchVersion.current)
            return;
          message.error(
            e instanceof ApiError
              ? describeError(e.code, e.message)
              : "搜索失败",
          );
        })
        .finally(() => {
          if (version === searchVersion.current) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [q, type, open, message]);

  const goTo = (item: SearchItem) => {
    setQ("");
    setOpen(false);
    if (item.type === "room") navigate(`/rooms?focus=${item.id}`);
    else if (item.type === "recording") navigate(`/history?focus=${item.id}`);
    else navigate("/settings");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      setQ("");
      return;
    }
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[activeIdx]) {
      e.preventDefault();
      goTo(results[activeIdx]);
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  return (
    <div
      className="lr-globalsearch"
      onKeyDown={onKeyDown}
    >
      <Input.Search
        size="small"
        ref={inputRef}
        allowClear
        placeholder="搜索房间 / 录像 / 告警"
        value={q}
        loading={loading}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => !q && setOpen(false), 50)}
      />
      {open ? (
        <div className="lr-globalsearch__popup">
          <div className="lr-globalsearch__filters">
            <Segmented
              size="small"
              options={TYPE_OPTIONS}
              value={type}
              onChange={(v) => setType(v as "all" | SearchItemType)}
              block
            />
          </div>
          {q.trim().length < 1 ? (
            <Typography.Paragraph
              type="secondary"
              className="lr-globalsearch__empty"
            >
              输入关键词开始搜索
            </Typography.Paragraph>
          ) : (
            <div ref={listRef} className="lr-globalsearch__list">
              <List
                size="small"
                loading={loading}
                dataSource={results}
                locale={{
                  emptyText: total > 0 ? "无匹配结果" : "未找到相关内容",
                }}
                renderItem={(item, i) => (
                  <List.Item
                    data-idx={i}
                    className="lr-globalsearch__result" style={{
                      background:
                        i === activeIdx ? "var(--lr-hover-bg)" : "transparent"
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goTo(item)}
                  >
                    <List.Item.Meta
                      title={
                        <Typography.Text
                          strong
                          ellipsis
                          className="lr-globalsearch__title"
                        >
                          {itemTitle(item)}
                        </Typography.Text>
                      }
                      description={
                        <Space size={8} wrap>
                          <Typography.Text
                            type="secondary"
                            className="lr-globalsearch__description"
                          >
                            {item.type === "room"
                              ? "房间"
                              : item.type === "recording"
                                ? "录像"
                                : "告警"}
                          </Typography.Text>
                          {item.occurredAt ? (
                            <Typography.Text
                              type="secondary"
                              className="lr-globalsearch__description"
                            >
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
                <Typography.Paragraph
                  type="secondary"
                  className="lr-globalsearch__more"
                >
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
