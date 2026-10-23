import { youtubeFetch } from "../platform/youtube-network.js";
import { youtubeCookieHeader } from "../danmaku/adapters/youtube.js";

/** A failed network probe is unknown, never proof that a saved session expired. */
export async function checkYoutubeCookieStatus(
  cookie: string,
): Promise<"valid" | "invalid" | "unknown"> {
  const header = youtubeCookieHeader(cookie);
  if (
    !/(?:^|;\s*)(?:SID|SAPISID|__Secure-3PAPISID|__Secure-1PAPISID)=/.test(
      header,
    )
  )
    return "invalid";
  try {
    const { Innertube } = await import("youtubei.js");
    const client = await Innertube.create({
      retrieve_player: false,
      cookie: header,
      fetch: (input, init) =>
        youtubeFetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
    });
    await client.account.getInfo();
    return "valid";
  } catch (error) {
    return /sign.in|not signed|unauthenticated|login required/i.test(
      error instanceof Error ? error.message : "",
    )
      ? "invalid"
      : "unknown";
  }
}
