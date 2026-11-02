export function parseDouyinRoomId(raw: string): string | null {
  const url = raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const match = /^https?:\/\/(?:live\.douyin\.com\/|www\.douyin\.com\/root\/live\/)(\d+)$/.exec(url);
  return match?.[1] ?? null;
}

export function normalizeDouyinUrl(raw: string): string {
  const roomId = parseDouyinRoomId(raw);
  return roomId
    ? `https://live.douyin.com/${roomId}`
    : raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
}
