import { useCallback, useState } from "react";
import { readPref, writePref, type PrefCodec } from "../utils/prefStorage";

export function useLocalPref<T>(
  key: string,
  fallback: T,
  codec?: PrefCodec<T>,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback, codec));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writePref(key, next, codec);
    },
    [key, codec],
  );
  return [value, set];
}
