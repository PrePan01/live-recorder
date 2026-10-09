/**
 * 本地偏好存储
 */
export interface PrefCodec<T> {
  read: (raw: string) => T;
  write: (value: T) => string;
}

export const jsonPrefCodec: PrefCodec<unknown> = {
  read: (raw) => JSON.parse(raw),
  write: (value) => JSON.stringify(value),
};

export function readPref<T>(
  key: string,
  fallback: T,
  codec: PrefCodec<T> = jsonPrefCodec as PrefCodec<T>,
): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : codec.read(raw);
  } catch {
    return fallback;
  }
}

export function writePref<T>(
  key: string,
  value: T,
  codec: PrefCodec<T> = jsonPrefCodec as PrefCodec<T>,
): void {
  try {
    window.localStorage.setItem(key, codec.write(value));
  } catch {
    /* 存储不可用时仅本次会话生效 */
  }
}
