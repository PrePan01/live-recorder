import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  App,
  Button,
  Form,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/error/errorMap";

interface Plan {
  id: string;
  enabled: boolean;
}

interface Props<Item extends Plan, Values extends object> {
  roomId: string;
  label: string;
  columns: ColumnsType<Item>;
  scrollWidth: number;
  load: (roomId: string) => Promise<Item[]>;
  onCountChange: (count: number) => void;
  toggle: (roomId: string, item: Item, enabled: boolean) => Promise<unknown>;
  remove: (roomId: string, id: string) => Promise<unknown>;
  save: (roomId: string, item: Item | null, values: Values) => Promise<unknown>;
  initialValues: (item: Item | null) => Values;
  fields: ReactNode;
  inlineEditor?: boolean;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError
    ? describeError(error.code, error.message)
    : fallback;
}

export default function PlanPanel<Item extends Plan, Values extends object>({
  roomId,
  label,
  columns,
  scrollWidth,
  load,
  onCountChange,
  toggle,
  remove,
  save,
  initialValues,
  fields,
  inlineEditor = false,
}: Props<Item, Values>) {
  const { message } = App.useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Item | null>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [form] = Form.useForm<Values>();

  useEffect(() => {
    let active = true;
    void load(roomId)
      .then((result) => {
        if (!active) return;
        setItems(result);
        onCountChange(result.length);
      })
      .catch((error: unknown) => {
        if (active) message.error(errorMessage(error, "计划加载失败"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, message, onCountChange, revision, roomId]);

  const mutate = async (action: () => Promise<unknown>, failure: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
      setLoading(true);
      setRevision((value) => value + 1);
    } catch (error) {
      message.error(errorMessage(error, failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const submit = (values: Values) => {
    if (editing === undefined) return;
    void mutate(async () => {
      await save(roomId, editing, values);
      message.success(editing ? "计划已更新" : "计划已创建");
      setEditing(undefined);
    }, "计划保存失败");
  };

  const disabled = loading || busy || (inlineEditor && editing !== undefined);
  const tableColumns: ColumnsType<Item> = [
    ...columns,
    {
      title: "启用",
      width: 70,
      render: (_, item) => (
        <Switch
          aria-label={`启用该${label}`}
          checked={item.enabled}
          disabled={disabled}
          onChange={(enabled) =>
            void mutate(() => toggle(roomId, item, enabled), "操作失败")
          }
        />
      ),
    },
    {
      title: "操作",
      width: 120,
      render: (_, item) => (
        <Space size={0}>
          <Button
            size="small"
            type="link"
            disabled={disabled}
            onClick={() => setEditing(item)}
          >
            编辑
          </Button>
          <Popconfirm
            title="删除该计划？"
            disabled={disabled}
            onConfirm={() => mutate(() => remove(roomId, item.id), "删除失败")}
          >
            <Button size="small" type="link" danger disabled={disabled}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const editorTitle = `${editing ? "编辑" : "新增"}${label}`;
  const enabledField = (
    <Form.Item label="启用" name="enabled" valuePropName="checked">
      <Switch aria-label="启用" />
    </Form.Item>
  );
  const editor = editing !== undefined && (
    <Form
      className={inlineEditor ? "lr-inline-plan-editor" : undefined}
      form={form}
      layout="vertical"
      initialValues={initialValues(editing)}
      clearOnDestroy
      onFinish={submit}
      disabled={busy}
    >
      {inlineEditor && <h3>{editorTitle}</h3>}
      {fields}
      {inlineEditor ? (
        <div className="lr-inline-plan-editor__footer">
          {enabledField}
          <Space>
            <Button disabled={busy} onClick={() => setEditing(undefined)}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={busy}>
              保存计划
            </Button>
          </Space>
        </div>
      ) : (
        enabledField
      )}
    </Form>
  );

  return (
    <div>
      {inlineEditor && editor ? (
        editor
      ) : (
        <Button
          size="small"
          style={{ marginBottom: 12 }}
          disabled={disabled}
          onClick={() => setEditing(null)}
        >
          新增{label}
        </Button>
      )}
      <Table
        rowKey="id"
        size="small"
        columns={tableColumns}
        dataSource={items}
        loading={loading}
        sticky={{ offsetScroll: 8 }}
        scroll={{ x: scrollWidth }}
        pagination={false}
        locale={{ emptyText: `暂无${label}` }}
      />
      {!inlineEditor && (
        <Modal
          title={editorTitle}
          open={editing !== undefined}
          onCancel={() => {
            if (!busy) setEditing(undefined);
          }}
          onOk={() => form.submit()}
          confirmLoading={busy}
          destroyOnHidden
        >
          {editor}
        </Modal>
      )}
    </div>
  );
}
