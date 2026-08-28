import { Space, Tag } from 'antd';
import { PlayCircleFilled, AudioFilled } from '@ant-design/icons';
import type { Platform } from '../types/room';

const PLATFORM_STYLE: Record<Platform, { color: string; bg: string; label: string }> = {
  bilibili: { color: '#fb7299', bg: 'rgba(251,114,153,0.12)', label: 'B站' },
  douyin: { color: '#000000', bg: 'rgba(0,0,0,0.06)', label: '抖音' },
};

export function PlatformIcon({ platform, size = 14 }: { platform: Platform; size?: number }) {
  const style = PLATFORM_STYLE[platform];
  const Icon = platform === 'bilibili' ? PlayCircleFilled : AudioFilled;
  return <Icon style={{ color: style.color, fontSize: size }} />;
}

export function PlatformLogoTag({ platform }: { platform: Platform }) {
  const style = PLATFORM_STYLE[platform];
  const Icon = platform === 'bilibili' ? PlayCircleFilled : AudioFilled;
  return (
    <Tag style={{ background: style.bg, borderColor: 'transparent', borderRadius: 4 }}>
      <Space size={4}>
        <Icon style={{ color: style.color, fontSize: 13 }} />
        <span style={{ color: style.color, fontWeight: 600 }}>{style.label}</span>
      </Space>
    </Tag>
  );
}