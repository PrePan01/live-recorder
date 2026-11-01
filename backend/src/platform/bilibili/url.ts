export function normalizeBilibiliUrl(raw: string): string {
  return raw
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

export function validateBilibiliUrl(raw: string): boolean {
  return /^https?:\/\/(live\.bilibili\.com|m\.live\.bilibili\.com|bilibili\.com)\/\d+/.test(
    raw.trim(),
  );
}

export function parseBilibiliRoomId(roomUrl: string): number | null {
  const match =
    /^https?:\/\/(?:live\.bilibili\.com|m\.live\.bilibili\.com|bilibili\.com)\/(\d+)/.exec(
      normalizeBilibiliUrl(roomUrl),
    );
  return match ? Number(match[1]) : null;
}
