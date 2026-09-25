import { describe, expect, it, vi } from "vitest";
import { DouyinAdapter } from "../../src/platform/douyin.js";

function mockFetcher(resolver: (url: string) => unknown): typeof fetch {
  return async (url) =>
    new Response(JSON.stringify(resolver(String(url))), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
}

function statusFetcher(status: number): typeof fetch {
  return async () => new Response("", { status }) as unknown as Response;
}

function livePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    status_code: 0,
    data: {
      data: [
        {
          id: "123456",
          status: 2,
          title: "抖音直播间",
          user: { nickname: "抖音主播" },
          stream_url: {
            flv_pull_url: {
              FULL_HD1: "https://pull.example.com/full.flv",
              HD1: "https://pull.example.com/hd1.flv",
              SD1: "https://pull.example.com/sd1.flv",
              SD2: "https://pull.example.com/sd2.flv",
            },
            default_resolution: "FULL_HD1",
          },
          ...overrides,
        },
      ],
    },
  };
}

describe("DouyinAdapter", () => {
  it("validates, normalizes and parses room urls", () => {
    const a = new DouyinAdapter();
    expect(a.validateUrl("https://live.douyin.com/123")).toBe(true);
    expect(a.validateUrl("https://live.douyin.com/abc")).toBe(false);
    expect(a.validateUrl("https://example.com/123")).toBe(false);
    expect(a.normalizeUrl("https://live.douyin.com/9/?x=1#t")).toBe(
      "https://live.douyin.com/9",
    );
    expect(a.parseRoomId("https://live.douyin.com/123456?x=1")).toBe("123456");
    expect(a.parseRoomId("https://example.com/1")).toBeNull();
  });

  it("reports live with session id, title, displayName and qualities", async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload()));
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(result.status).toBe("live");
    expect(result.streamSessionId).toBe("123456");
    expect(result.streamTitle).toBe("抖音直播间");
    expect(result.displayName).toBe("抖音主播");
    expect(result.availableQualities).toEqual([
      "original",
      "1080p",
      "720p",
      "360p",
    ]);
  });

  it("uses the enter API's 1080px avatar_large URL without a second page request", async () => {
    const a = new DouyinAdapter(
      mockFetcher(() =>
        livePayload({
          user: {
            nickname: "抖音主播",
            avatar_thumb: {
              url_list: ["https://p3.douyinpic.com/img/a~c5_100x100.jpeg"],
            },
            avatar_large: {
              url_list: ["https://p9.douyinpic.com/img/a~c5_1080x1080.jpeg"],
            },
          },
        }),
      ),
    );
    await expect(
      a.checkLiveStatus("https://live.douyin.com/123456", "sessionid=x"),
    ).resolves.toMatchObject({
      avatarUrl: "https://p9.douyinpic.com/img/a~c5_1080x1080.jpeg",
    });
  });

  it("昵称解析不到时用房间号占位，绝不用直播间标题冒充主播昵称（添加房间显示名回归）", async () => {
    // enter 缺 user.nickname 且页面解析不到昵称：以前 displayName 会用 title 兜底，
    // 添加房间后「显示名」就变成了当场的直播标题。昵称只能来自昵称源，取不到就用占位。
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ user: {} })));
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(result.status).toBe("live");
    expect(result.displayName).toBe("douyin_123456");
    expect(result.displayName).not.toBe("抖音直播间");
    expect(result.streamTitle).toBe("抖音直播间");
    expect(result.titleSource).toBe("placeholder");
    expect(result.titleFallbackUsed).toBe(true);
  });

  it("resolves anchor nickname from the room page when enter API lacks user.nickname (验收 #2a)", async () => {
    // 抖音接口结构变更：enter 不再返回 user.nickname → 从直播间页面 data-anchor-info 解析主播昵称。
    // 匿名请求直播间页面会被挡在“验证码中间页”（页面里没有 data-anchor-info），所以必须带上会话 Cookie。
    let pageCookie: string | undefined;
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/webcast/room/web/enter")) {
        return new Response(JSON.stringify(livePayload({ user: {} })), {
          status: 200,
        });
      }
      pageCookie = (init?.headers as Record<string, string> | undefined)
        ?.Cookie;
      return new Response(
        `<html><body><div data-anchor-info="{&quot;nickname&quot;:&quot;青泠&quot;,&quot;avatar&quot;:&quot;x&quot;}">x</div></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    const a = new DouyinAdapter(fetcher);
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(result.status).toBe("live");
    expect(result.displayName).toBe("青泠");
    expect(result.streamTitle).toBe("抖音直播间");
    expect(result.titleSource).toBe("adapter");
    expect(pageCookie).toBe("sessionid=x");
  });

  it("reports offline when status is not 2", async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ status: 4 })));
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(result.status).toBe("offline");
  });

  it("treats a newly-live room without a stream url as a retryable platform delay, not an authorization failure", async () => {
    const a = new DouyinAdapter(
      mockFetcher(() => livePayload({ stream_url: {} })),
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NETWORK_UNAVAILABLE");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).toContain("正在等待平台生成流地址");
  });

  it("rechecks once when a room transitions from offline to live before its stream url is ready", async () => {
    let requests = 0;
    const a = new DouyinAdapter(async () => {
      requests += 1;
      return new Response(
        JSON.stringify(
          requests === 1 ? livePayload({ stream_url: {} }) : livePayload(),
        ),
        { status: 200 },
      ) as unknown as Response;
    });

    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(requests).toBe(2);
    expect(result.status).toBe("live");
  });

  it("maps network failures to NETWORK_UNAVAILABLE", async () => {
    const a = new DouyinAdapter(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NETWORK_UNAVAILABLE");
    expect(result.error?.retryable).toBe(true);
  });

  it("retries a transient upstream HTTP failure instead of reporting PLATFORM_CHANGED", async () => {
    let requests = 0;
    const a = new DouyinAdapter(async () => {
      requests += 1;
      return requests === 1
        ? (new Response("", { status: 503 }) as unknown as Response)
        : (new Response(JSON.stringify(livePayload()), {
            status: 200,
          }) as unknown as Response);
    });

    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=valid",
    );
    expect(requests).toBe(2);
    expect(result.status).toBe("live");
  });

  it("reports persistent 429/5xx as retryable network failure, not PLATFORM_CHANGED", async () => {
    const a = new DouyinAdapter(
      async () => new Response("", { status: 429 }) as unknown as Response,
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=valid",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NETWORK_UNAVAILABLE");
    expect(result.error?.retryable).toBe(true);
  });

  it("returns error for an invalid url", async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload()));
    const result = await a.checkLiveStatus("https://example.com/1");
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("ROOM_LINK_INVALID");
  });

  it("getStreamUrl picks the requested quality and falls back gracefully", async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload()));
    const original = await a.getStreamUrl(
      "https://live.douyin.com/123456",
      "original",
      "sessionid=x",
    );
    expect(original.url).toBe("https://pull.example.com/full.flv");
    expect(original.format).toBe("flv");
    expect(original.actualQuality).toBe("original");
    expect(original.headers?.["Referer"]).toBe(
      "https://live.douyin.com/123456",
    );

    const hd1 = await a.getStreamUrl(
      "https://live.douyin.com/123456",
      "1080p",
      "sessionid=x",
    );
    expect(hd1.url).toBe("https://pull.example.com/hd1.flv");
    expect(hd1.actualQuality).toBe("1080p");

    const sd1 = await a.getStreamUrl(
      "https://live.douyin.com/123456",
      "720p",
      "sessionid=x",
    );
    expect(sd1.url).toBe("https://pull.example.com/sd1.flv");

    const sd2 = await a.getStreamUrl(
      "https://live.douyin.com/123456",
      "360p",
      "sessionid=x",
    );
    expect(sd2.url).toBe("https://pull.example.com/sd2.flv");
  });

  it("getStreamUrl reports a retryable platform delay when a newly-live room has no stream url", async () => {
    const a = new DouyinAdapter(
      mockFetcher(() => livePayload({ stream_url: {} })),
    );
    await expect(
      a.getStreamUrl(
        "https://live.douyin.com/123456",
        "original",
        "sessionid=x",
      ),
    ).rejects.toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      retryable: true,
    });
  });

  it("maps empty responses (anti-crawl) to PLATFORM_ACCESS_RESTRICTED", async () => {
    const a = new DouyinAdapter(
      async () => new Response("", { status: 200 }) as unknown as Response,
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(result.status).toBe("restricted");
    expect(result.error?.code).toBe("PLATFORM_ACCESS_RESTRICTED");
  });

  it("does not treat a transient 10011 as an expired cookie", async () => {
    // `10011` 也会携带“服务繁忙，请稍后重试”，此时设置页的登录态仍有效；
    // 不能以一次房间检测熔断所有房间并要求重新授权。
    const a = new DouyinAdapter(
      mockFetcher(() => ({
        status_code: 10011,
        data: {
          message: "Request params error",
          prompts: "当前服务繁忙，请稍后重试",
        },
      })),
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=expired",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NETWORK_UNAVAILABLE");
    expect(result.error?.retryable).toBe(true);
  });

  it("keeps the global re-authorization path for an explicit expired-session response", async () => {
    const a = new DouyinAdapter(
      mockFetcher(() => ({ status_code: 8, data: { message: "请先登录" } })),
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=expired",
    );
    expect(result.status).toBe("restricted");
    expect(result.error?.code).toBe("DOUYIN_COOKIE_EXPIRED");
  });

  it("maps unexpected structure without cookie signal to PLATFORM_CHANGED", async () => {
    // 结构异常但非凭证特征 → 仍判平台变动（真接口变更）。
    const a = new DouyinAdapter(
      mockFetcher(() => ({ status_code: 99999, foo: "bar" })),
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=xxx",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("PLATFORM_CHANGED");
  });

  it("maps 抖音 4001038 to a room-content-unavailable error, not PLATFORM_CHANGED", async () => {
    // 实测响应：{ status_code: 4001038, data: { prompts: '该内容暂时无法无法查看' } }。
    // 这是房间内容暂不可访问，不是 enter 接口字段变更。
    const a = new DouyinAdapter(
      mockFetcher(() => ({
        status_code: 4001038,
        data: { prompts: "该内容暂时无法无法查看" },
      })),
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/228601310418",
      "sessionid=x",
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({
      code: "ROOM_CONTENT_UNAVAILABLE",
      message: "直播间当前不可查看，请稍后重试",
      retryable: true,
    });
    await expect(
      a.getStreamUrl(
        "https://live.douyin.com/228601310418",
        "original",
        "sessionid=x",
      ),
    ).rejects.toMatchObject({
      code: "ROOM_CONTENT_UNAVAILABLE",
      message: "直播间当前不可查看，请稍后重试",
    });
  });

  it('把"没有房间条目"判成未开播，而不是接口变动（下播房间误报 PLATFORM_CHANGED 回归）', async () => {
    // 抖音对不在播的房间返回 status_code=0 但没有任何房间条目：以前会落到 PLATFORM_CHANGED，
    // 已下播的房间于是每个检测周期都报一次"平台接口有变动"（实测刷出 150+ 条告警）。
    const empty = new DouyinAdapter(
      mockFetcher(() => ({ status_code: 0, data: { data: [] } })),
    );
    const emptyResult = await empty.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(emptyResult.status).toBe("offline");
    expect(emptyResult.error).toBeUndefined();

    // data.data 直接缺失也是同一种情况。
    const missing = new DouyinAdapter(
      mockFetcher(() => ({ status_code: 0, data: {} })),
    );
    const missingResult = await missing.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=x",
    );
    expect(missingResult.status).toBe("offline");

    // 取流时同样不该说成接口变动。
    const stream = new DouyinAdapter(
      mockFetcher(() => ({ status_code: 0, data: { data: [] } })),
    );
    await expect(
      stream.getStreamUrl(
        "https://live.douyin.com/123456",
        "original",
        "sessionid=x",
      ),
    ).rejects.toMatchObject({
      code: "RECORDING_NOT_AVAILABLE",
    });
  });

  it('把下播实测形状 status_code=30003/"room has finished" 判成未开播，而不是接口变动', async () => {
    // 诊断包实测：房间下播后抖音返回 status_code=30003、无房间条目、提示 "room has finished"。
    // 以前只认 status_code=0 的未开播形状，于是这一段时间里误报"平台接口有变动"。
    const a = new DouyinAdapter(
      mockFetcher(() => ({
        status_code: 30003,
        data: { message: "room has finished" },
      })),
    );
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/440323816405",
      "sessionid=x",
    );
    expect(result.status).toBe("offline");
    expect(result.error).toBeUndefined();
    await expect(
      a.getStreamUrl(
        "https://live.douyin.com/440323816405",
        "original",
        "sessionid=x",
      ),
    ).rejects.toMatchObject({
      code: "RECORDING_NOT_AVAILABLE",
    });

    // 换了个状态码但仍是"直播已结束"文案时，也要按未开播处理。
    const byText = new DouyinAdapter(
      mockFetcher(() => ({
        status_code: 10000,
        data: { message: "room has finished" },
      })),
    );
    expect(
      (await byText.checkLiveStatus("https://live.douyin.com/1", "sessionid=x"))
        .status,
    ).toBe("offline");

    // 凭证类响应（8=需登录）即使没有房间条目也不能被"未开播"判定吞掉。
    const expired = new DouyinAdapter(
      mockFetcher(() => ({ status_code: 8, data: { message: "请先登录" } })),
    );
    expect(
      (
        await expired.checkLiveStatus(
          "https://live.douyin.com/1",
          "sessionid=x",
        )
      ).error?.code,
    ).toBe("DOUYIN_COOKIE_EXPIRED");
  });

  it("maps 抖音 444（边缘节点掐断连接）to a retryable outage, never an authorization failure", async () => {
    // 444 会在有效登录态下偶发出现；不能让设置页显示“已登录”而监控页要求重新授权。
    const a = new DouyinAdapter(statusFetcher(444));
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=stale",
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NETWORK_UNAVAILABLE");
    expect(result.error?.retryable).toBe(true);
    // 用户看不懂 HTTP 状态码：绝不能出现在给用户看的文案里（技术细节只留在 details）。
    expect(result.error?.message).not.toContain("444");
    expect(result.error?.details?.httpStatus).toBe(444);
  });

  it("抖音未授权（无 Cookie）时不发任何平台请求，直接报平台访问受限", async () => {
    // 匿名 enter 请求结果不可靠：可能返回看似正常的数据（房间被当成离线，卡片上看不到报错），
    // 也可能长时间不返回把房间留在「检测中」。未登录必须走确定性失败，提示去设置登录授权。
    let calls = 0;
    const a = new DouyinAdapter(async () => {
      calls += 1;
      return new Response("", { status: 444 }) as unknown as Response;
    });
    const result = await a.checkLiveStatus("https://live.douyin.com/123456");
    expect(calls).toBe(0);
    expect(result.status).toBe("restricted");
    expect(result.error?.code).toBe("PLATFORM_ACCESS_RESTRICTED");
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toBe("平台访问受限，请检查抖音授权");
  });

  it("getStreamUrl 未授权时同样拒绝匿名取流", async () => {
    let calls = 0;
    const a = new DouyinAdapter(async () => {
      calls += 1;
      return new Response(JSON.stringify(livePayload()), {
        status: 200,
      }) as unknown as Response;
    });
    await expect(
      a.getStreamUrl("https://live.douyin.com/123456", "original"),
    ).rejects.toMatchObject({
      code: "PLATFORM_ACCESS_RESTRICTED",
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it("retries once when the edge drops the request (444 then success)", async () => {
    // 偶发掐断要在重试后自愈，而不是把用户赶去重新登录。
    let calls = 0;
    const a = new DouyinAdapter(async () => {
      calls += 1;
      return calls === 1
        ? (new Response("", { status: 444 }) as unknown as Response)
        : (new Response(JSON.stringify(livePayload()), {
            status: 200,
          }) as unknown as Response);
    });
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=ok",
    );
    expect(result.status).toBe("live");
    expect(calls).toBe(2);
  });

  it("serializes concurrent enter requests from polling and recording recovery", async () => {
    let inFlight = 0;
    let peak = 0;
    const a = new DouyinAdapter(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(JSON.stringify(livePayload()), {
        status: 200,
      }) as unknown as Response;
    });

    const [first, second] = await Promise.all([
      a.checkLiveStatus("https://live.douyin.com/111", "sessionid=ok"),
      a.checkLiveStatus("https://live.douyin.com/222", "sessionid=ok"),
    ]);
    expect(first.status).toBe("live");
    expect(second.status).toBe("live");
    expect(peak).toBe(1);
  });

  it("用户取流插队到排队的后台检测之前（打开预览不被批量检测堵住）", async () => {
    // 回归：刷新时的批量检测会把 enter 请求排满队列，打开新预览的取流请求排在最后，
    // 前端就一直卡在“连接视频流”，直到整轮检测跑完。取流必须优先于排队中的检测。
    const order: string[] = [];
    let releaseFirst!: () => void;
    const a = new DouyinAdapter(async (url) => {
      const rid = /web_rid=([^&]+)/.exec(String(url))?.[1] ?? "?";
      order.push(rid);
      // 第一个请求卡住，制造“正在执行 + 后面排队”的场景。
      if (order.length === 1)
        await new Promise<void>((r) => (releaseFirst = r));
      return new Response(JSON.stringify(livePayload()), {
        status: 200,
      }) as unknown as Response;
    });

    const bg1 = a.checkLiveStatus(
      "https://live.douyin.com/100",
      "sessionid=ok",
    );
    const bg2 = a.checkLiveStatus(
      "https://live.douyin.com/200",
      "sessionid=ok",
    );
    const preview = a.getStreamUrl(
      "https://live.douyin.com/999",
      "original",
      "sessionid=ok",
    );

    releaseFirst();
    const [, , stream] = await Promise.all([bg1, bg2, preview]);
    expect(stream.url).toBe("https://pull.example.com/full.flv");
    expect(order).toEqual(["100", "999", "200"]);
  });

  it("never leaks other unexpected HTTP statuses into user-facing copy", async () => {
    const a = new DouyinAdapter(statusFetcher(451));
    const result = await a.checkLiveStatus(
      "https://live.douyin.com/123456",
      "sessionid=ok",
    );
    expect(result.error?.code).toBe("NETWORK_UNAVAILABLE");
    expect(result.error?.message).not.toContain("451");
    expect(result.error?.details?.httpStatus).toBe(451);
  });

  it("passes cookie through and uses web_rid param (douyin API P0 fix)", async () => {
    let sentCookie: string | undefined;
    let sentUrl = "";
    let hasTimeoutSignal = false;
    const a = new DouyinAdapter(async (url, init) => {
      sentUrl = String(url);
      sentCookie = (init?.headers as Record<string, string> | undefined)
        ?.Cookie;
      hasTimeoutSignal = init?.signal instanceof AbortSignal;
      return new Response(JSON.stringify(livePayload()), {
        status: 200,
      }) as unknown as Response;
    });
    await a.checkLiveStatus("https://live.douyin.com/123456", "sessionid=xxx");
    expect(sentCookie).toBe("sessionid=xxx");
    expect(hasTimeoutSignal).toBe(true);
    // P0：抖音接口须用 web_rid，room_id_str 会返回 status_code=10011。
    expect(sentUrl).toContain("web_rid=123456");
    expect(sentUrl).not.toContain("room_id_str");
  });

  it("把误判结构的 enter 响应摘要写进诊断日志，便于定位过渡期误报（不含响应体/地址）", async () => {
    const warns: string[] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((line: unknown) => {
        warns.push(String(line));
      });
    try {
      // 开播/关播过渡期可能返回非 0 状态码却没有任何房间条目：当前会被判成 PLATFORM_CHANGED。
      // 这条日志把真实 status_code/形状留进诊断包，用于确认到底是哪种响应。
      const a = new DouyinAdapter(
        mockFetcher(() => ({
          status_code: 10003,
          data: { data: [], message: "Request params error" },
        })),
      );
      const result = await a.checkLiveStatus(
        "https://live.douyin.com/123456",
        "sessionid=secret-cookie",
      );
      expect(result.error?.code).toBe("PLATFORM_CHANGED");
    } finally {
      spy.mockRestore();
    }
    const line = warns.find((w) => w.includes("[douyin-enter]"));
    expect(line).toBeDefined();
    expect(line).toContain("status_code=10003");
    expect(line).toContain("entries=0");
    expect(line).not.toContain("secret-cookie");
    expect(line).not.toContain("https://");
  });

  it("正常的在播/未开播检测不写诊断日志，避免污染 backend.log", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const live = new DouyinAdapter(mockFetcher(() => livePayload()));
      await live.checkLiveStatus(
        "https://live.douyin.com/123456",
        "sessionid=x",
      );
      const offline = new DouyinAdapter(
        mockFetcher(() => ({ status_code: 0, data: { data: [] } })),
      );
      await offline.checkLiveStatus(
        "https://live.douyin.com/123456",
        "sessionid=x",
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("头像与昵称同次页面抓取解析并 TTL 缓存（检测周期 0 额外请求），非 http 脏值拒绝", async () => {
    let pageHits = 0;
    const fetcher = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/webcast/room/web/enter")) {
        return new Response(JSON.stringify(livePayload({ user: {} })), { status: 200 });
      }
      pageHits += 1;
      return new Response(
        `<html><div data-anchor-info="{&quot;nickname&quot;:&quot;青泠&quot;,&quot;avatar&quot;:&quot;https://p3.douyinpic.com/a.jpg&quot;}">x</div></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    const a = new DouyinAdapter(fetcher);
    const live = await a.checkLiveStatus("https://live.douyin.com/667788", "sessionid=x");
    expect(live.avatarUrl).toBe("https://p3.douyinpic.com/a.jpg");
    expect(pageHits).toBe(1);
    // TTL 缓存内第二次检测不再拉页面 = 0 额外请求实证
    const again = await a.checkLiveStatus("https://live.douyin.com/667788", "sessionid=x");
    expect(pageHits).toBe(1);
    expect(again.avatarUrl).toBe("https://p3.douyinpic.com/a.jpg");

    // 非 http 脏值（沿用验收 #2a 夹具 avatar:"x"）→ 拒绝为 null
    const dirty = await new DouyinAdapter(
      (async () =>
        new Response(
          `<html><div data-anchor-info="{&quot;nickname&quot;:&quot;乙&quot;,&quot;avatar&quot;:&quot;x&quot;}">y</div></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        )) as typeof fetch,
    ).fetchAnchorProfile("991122");
    expect(dirty.avatar).toBeNull();
  });

  it("nicknameHint（enter 接口昵称）时不拉页面：头像降级 null，绝不为头像多发请求", async () => {
    let pageHits = 0;
    const fetcher = (async () => {
      pageHits += 1;
      return new Response("<html></html>", { status: 200 });
    }) as typeof fetch;
    const a = new DouyinAdapter(fetcher);
    const p = await a.fetchAnchorProfile("13579", undefined, "有昵称");
    expect(p).toEqual({ name: "有昵称", avatar: null });
    expect(pageHits).toBe(0);
  });

  it("优先保存 SSR avatar_larger.url_list 的高清头像", async () => {
    const a = new DouyinAdapter(
      (async () =>
        new Response(
          `<html><div data-anchor-info="{&quot;nickname&quot;:&quot;主播&quot;,&quot;avatar&quot;:&quot;https://p3.douyinpic.com/img/tos/a~c5_100x100.jpeg&quot;}"></div><script>{"avatar_larger":{"url_list":["https://p9.douyinpic.com/img/tos/a~c5_1080x1080.jpeg"]}}</script></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        )) as typeof fetch,
    );
    await expect(a.fetchAnchorProfile("24680")).resolves.toEqual({
      name: "主播",
      avatar: "https://p9.douyinpic.com/img/tos/a~c5_1080x1080.jpeg",
    });
  });

});
