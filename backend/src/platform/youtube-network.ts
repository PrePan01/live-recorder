import { promisify } from "node:util";
import { AppError } from "../types/error.js";

export function parseSystemProxy(
  text: string,
  platform: string,
): string | undefined {
  if (platform === "darwin") {
    for (const kind of ["HTTPS", "HTTP"]) {
      const enabled = new RegExp(`\\b${kind}Enable\\s*:\\s*1\\b`).test(text);
      const host = new RegExp(`\\b${kind}Proxy\\s*:\\s*(\\S+)`).exec(text)?.[1];
      const port = new RegExp(`\\b${kind}Port\\s*:\\s*(\\d+)`).exec(text)?.[1];
      if (enabled && host && port) return `http://${host}:${port}`;
    }
  } else if (platform === "win32") {
    try {
      const settings = JSON.parse(text) as {
        ProxyEnable?: number;
        ProxyServer?: string;
      };
      if (!settings.ProxyEnable || !settings.ProxyServer) return;
      const https = /(?:^|;)https=([^;]+)/.exec(settings.ProxyServer)?.[1];
      const http = /(?:^|;)http=([^;]+)/.exec(settings.ProxyServer)?.[1];
      const proxy =
        https ??
        http ??
        (!settings.ProxyServer.includes("=")
          ? settings.ProxyServer
          : undefined);
      if (proxy) return proxy.includes("://") ? proxy : `http://${proxy}`;
    } catch {
      /* missing system configuration means direct networking */
    }
  }
}

let cached: { until: number; value: Promise<string | undefined> } | undefined;
async function systemProxy(): Promise<string | undefined> {
  const environment =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy;
  if (environment) return environment;
  if (cached && cached.until > Date.now()) return cached.value;
  const value = (async () => {
    try {
      const { execFile } = await import("node:child_process");
      const execute = promisify(execFile);
      if (process.platform === "darwin")
        return parseSystemProxy(
          (
            await execute("/usr/sbin/scutil", ["--proxy"], {
              timeout: 2000,
              maxBuffer: 64 * 1024,
            })
          ).stdout,
          "darwin",
        );
      if (process.platform === "win32")
        return parseSystemProxy(
          (
            await execute(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress",
              ],
              { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 },
            )
          ).stdout,
          "win32",
        );
    } catch {
      /* a TUN/direct connection needs no explicit proxy */
    }
    return undefined;
  })();
  cached = { until: Date.now() + 60_000, value };
  return value;
}

let agent: { url: string; dispatcher: import("undici").ProxyAgent } | undefined;
/** One resolved network route for metadata, downloader and chat; no app proxy preference. */
export async function youtubeProxy(): Promise<string | undefined> {
  const proxy = await systemProxy();
  if (proxy && !/^https?:\/\//i.test(proxy))
    throw new AppError(
      "CONFIG_INVALID",
      "YouTube 媒体进程需要系统 HTTP/HTTPS 代理或全局网络连接",
    );
  return proxy;
}
export const youtubeFetch: typeof globalThis.fetch = async (input, init) => {
  // youtubei.js can supply a Request from its own fetch implementation. Node's
  // fetch and undici reject foreign Request objects as "[object Request]".
  // Cross the boundary using URL, headers and bytes rather than object identity.
  const request = typeof input === 'object' && input !== null && 'url' in input
    ? input as Request : undefined;
  const target = request?.url ?? input;
  const options: RequestInit | undefined = request ? {
    method: request.method,
    headers: new Headers(request.headers),
    signal: request.signal,
    redirect: request.redirect,
    ...(!['GET', 'HEAD'].includes(request.method) && init?.body === undefined
      ? { body: await request.arrayBuffer() } : {}),
    ...init,
  } : init;
  const proxy = await youtubeProxy();
  if (!proxy) return globalThis.fetch(target, options);
  const { ProxyAgent, fetch: proxyFetch } = await import("undici");
  if (agent?.url !== proxy) {
    if (agent) void agent.dispatcher.close();
    agent = { url: proxy, dispatcher: new ProxyAgent(proxy) };
  }
  return proxyFetch(
    target as Parameters<typeof proxyFetch>[0],
    { ...options, dispatcher: agent.dispatcher } as Parameters<
      typeof proxyFetch
    >[1],
  ) as unknown as Promise<Response>;
};
