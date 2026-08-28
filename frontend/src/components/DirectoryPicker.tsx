import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Input, Modal, Space, Spin, Tree, Typography } from 'antd';
import type { TreeDataNode } from 'antd';
import { FolderOpenOutlined, FolderOutlined } from '@ant-design/icons';
import { browseDirectories, pickDirectory } from '../api/config';
import { validateDirectory } from '../api/settings';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';

interface DirectoryPickerProps {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
  onPick: (path: string) => void;
}

function buildTree(children: { name: string; path: string }[]): TreeDataNode[] {
  return children.map((c) => ({
    key: c.path,
    title: c.name,
    icon: <FolderOutlined />,
    isLeaf: false,
    children: [],
  }));
}

export default function DirectoryPicker({ open, initialPath, onClose, onPick }: DirectoryPickerProps) {
  const { message } = App.useApp();
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parent, setParent] = useState<string | null>(null);
  const [treeData, setTreeData] = useState<TreeDataNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [validating, setValidating] = useState(false);

  const load = useCallback(
    async (path?: string) => {
      setLoading(true);
      try {
        const res = await browseDirectories(path);
        setCurrentPath(res.path);
        setParent(res.parent);
        setTreeData(buildTree(res.directories));
        setSelected('');
      } catch (e) {
        message.error(e instanceof ApiError ? describeError(e.code, e.message) : '目录读取失败');
      } finally {
        setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    if (open) void load(initialPath);
  }, [open, initialPath, load]);

  const onLoadData = async (node: { key: React.Key; children?: TreeDataNode[] }) => {
    const p = String(node.key);
    try {
      const res = await browseDirectories(p);
      const next = (node.children ?? []).map((c) => c);
      node.children = buildTree(res.directories);
      setTreeData((prev) => prev.map((t) => (t.key === node.key ? { ...t, children: node.children } : t)));
      void next;
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '目录读取失败');
    }
  };

  const pick = async () => {
    if (!selected) return;
    setValidating(true);
    try {
      await validateDirectory(selected);
      onPick(selected);
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '目录不可用');
    } finally {
      setValidating(false);
    }
  };

  const pickNative = async () => {
    try {
      const dir = await pickDirectory();
      if (dir) {
        onPick(dir);
        onClose();
      }
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '选择失败');
    }
  };

  return (
    <Modal
      title="选择录像保存目录"
      open={open}
      onCancel={onClose}
      width={520}
      footer={[
        <Button key="native" icon={<FolderOpenOutlined />} onClick={() => void pickNative()}>
          系统选择器
        </Button>,
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="ok" type="primary" loading={validating} disabled={!selected} onClick={() => void pick()}>
          使用此目录
        </Button>,
      ]}
    >
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input value={currentPath} readOnly placeholder="当前目录" />
        <Button
          disabled={!parent}
          onClick={() => {
            if (parent) void load(parent);
          }}
        >
          上一级
        </Button>
      </Space.Compact>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : treeData.length === 0 ? (
        <Empty description="无子目录" style={{ padding: 32 }} />
      ) : (
        <Tree
          showIcon
          blockNode
          loadData={onLoadData as never}
          treeData={treeData}
          expandedKeys={expandedKeys}
          onExpand={(keys) => setExpandedKeys(keys)}
          selectedKeys={selected ? [selected] : []}
          onSelect={(keys) => setSelected(keys.length > 0 ? String(keys[0]) : '')}
        />
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        选择后将对目录做可写校验；也可用上方「系统选择器」弹出系统原生窗口。
      </Typography.Paragraph>
    </Modal>
  );
}