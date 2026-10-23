import { youtubeFetch } from "../../platform/youtube-network.js";
import type { DanmakuAdapter, DanmakuMessage } from "../types.js";
import type { YoutubeAdapter } from "../../platform/youtube.js";
import { normalizeYoutubeCookies } from "../../platform/youtube-runtime.js";

export function youtubeCookieHeader(cookie: string): string {
  return normalizeYoutubeCookies(cookie)
    .split("\n")
    .filter(
      (line) =>
        line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")),
    )
    .flatMap((line) => {
      const fields = line.replace(/^#HttpOnly_/, "").split("\t");
      const domain = fields[0]!.replace(/^\./, "");
      const expires = Number(fields[4]);
      return (domain === "youtube.com" || domain.endsWith(".youtube.com")) &&
        (!expires || expires * 1000 > Date.now())
        ? [`${fields[5]}=${fields[6]}`]
        : [];
    })
    .join("; ");
}

export function createYoutubeDanmakuAdapter(
  platform: YoutubeAdapter,
): DanmakuAdapter {
  return {
    platform: "youtube",
    async *collect(
      roomUrl,
      cookie,
      signal,
      onConnected,
    ): AsyncIterable<DanmakuMessage> {
      const live = await platform.liveInfo(roomUrl, cookie ?? undefined);
      if (!live || signal.aborted) return;
      // Load the sizeable parser only when YouTube chat is actually requested.
      const { Innertube } = await import("youtubei.js");
      const client = await Innertube.create({
        retrieve_player: false,
        ...(cookie ? { cookie: youtubeCookieHeader(cookie) } : {}),
        fetch: (input, init) =>
          youtubeFetch(input, {
            ...init,
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          }),
      });
      if (signal.aborted) return;
      const info = await client.getInfo(live.id);
      const chat = info.getLiveChat();
      const queue: DanmakuMessage[] = [];
      const seen = new Set<string>();
      let queuedBytes = 0,
        ended = false,
        error: unknown,
        wake: (() => void) | undefined;
      const notify = () => {
        wake?.();
        wake = undefined;
      };
      const accept = (action: unknown) => {
        const item = (
          action as {
            item?: {
              id?: string;
              message?: { toString(): string };
              type?: string;
            };
          }
        )?.item;
        const text = item?.message?.toString();
        if (
          !item?.id ||
          !text ||
          ![
            "LiveChatTextMessage",
            "LiveChatPaidMessage",
            "LiveChatMembershipItem",
          ].includes(item.type ?? "") ||
          seen.has(item.id)
        )
          return;
        const size = Buffer.byteLength(text);
        if (size > 16000) return;
        if (queue.length >= 4096 || queuedBytes + size > 1024 * 1024) {
          error = new Error("YouTube 聊天消费过慢，正在恢复");
          ended = true;
          chat.stop();
          notify();
          return;
        }
        seen.add(item.id);
        if (seen.size > 8192) seen.delete(seen.values().next().value!);
        queue.push({
          id: `youtube:${live.id}:${item.id}`,
          text,
          wallMs: Date.now(),
          tMs: null,
        });
        queuedBytes += size;
        notify();
      };
      chat.on("start", (initial) => {
        onConnected?.();
        chat.applyFilter("LIVE_CHAT");
        for (const action of initial.actions ?? []) accept(action);
      });
      chat.on("chat-update", accept);
      chat.on("error", (cause) => {
        error = cause;
        ended = true;
        notify();
      });
      chat.on("end", () => {
        ended = true;
        notify();
      });
      const abort = () => {
        ended = true;
        chat.stop();
        notify();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) return;
        chat.start();
        while (!signal.aborted) {
          const message = queue.shift();
          if (message) {
            queuedBytes -= Buffer.byteLength(message.text);
            yield message;
          } else if (ended) {
            if (error) throw error;
            return;
          } else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      } finally {
        signal.removeEventListener("abort", abort);
        chat.stop();
        queue.length = 0;
      }
    },
  };
}
