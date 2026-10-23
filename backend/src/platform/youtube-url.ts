export type YoutubeTarget = {
  kind: "video" | "channel";
  id: string;
  url: string;
};

/** Parse only recognised YouTube hosts; never pass arbitrary URLs to the extractor. */
export function parseYoutubeUrl(raw: string): YoutubeTarget | null {
  try {
    const url = new URL(raw.trim());
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    let video: string | undefined;
    if (host === "youtu.be") video = parts.length === 1 ? parts[0] : undefined;
    else if (
      ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)
    ) {
      if (url.pathname === "/watch")
        video = url.searchParams.get("v") ?? undefined;
      else if (parts[0] === "live" && parts.length === 2) video = parts[1];
      else if (
        parts[0] === "channel" &&
        /^UC[\w-]{22}$/.test(parts[1] ?? "") &&
        parts.length <= 3 &&
        (!parts[2] || ["live", "streams"].includes(parts[2]))
      ) {
        return {
          kind: "channel",
          id: parts[1]!,
          url: `https://www.youtube.com/channel/${parts[1]}`,
        };
      } else if (
        parts[0]?.startsWith("@") &&
        /^@[\p{L}\p{N}_.%-]{3,100}$/u.test(parts[0]) &&
        parts.length <= 2 &&
        (!parts[1] || ["live", "streams"].includes(parts[1]))
      ) {
        return {
          kind: "channel",
          id: parts[0],
          url: `https://www.youtube.com/${parts[0]}`,
        };
      }
    }
    return video && /^[\w-]{11}$/.test(video)
      ? {
          kind: "video",
          id: video,
          url: `https://www.youtube.com/watch?v=${video}`,
        }
      : null;
  } catch {
    return null;
  }
}

export function normalizeYoutubeUrl(raw: string): string {
  return parseYoutubeUrl(raw)?.url ?? raw.trim();
}
