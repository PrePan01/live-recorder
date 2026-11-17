// Read the live page's own response. The browser runs the site's normal
// navigation and network code inside the user's restored website session.
(() => {
  if (location.origin !== 'https://live.douyin.com' || !/^\/\d+$/.test(location.pathname)) return;
  const room = location.pathname.slice(1);
  const state = window.__lrDouyinPage = { response: null };

  function isRoomResponse(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      return url.origin === location.origin && /^\/webcast\/room\/web\/enter\/?$/.test(url.pathname) &&
        url.searchParams.get('web_rid') === room;
    } catch { return false; }
  }

  function save(data) {
    if (![0, 30003, 4001038, 4003034].includes(data?.status_code)) return;
    const entry = data.data?.data?.[0];
    if (data.status_code === 0 && entry?.status === 2 &&
        !Object.keys(entry.stream_url?.flv_pull_url ?? {}).length) return;
    const text = JSON.stringify({
      status_code: data.status_code,
      data: data.status_code === 0
        ? { data: entry ? [entry] : [] }
        : { message: String(data.data?.message ?? data.data?.prompts ?? '').slice(0, 512) },
    });
    if (new TextEncoder().encode(text).length <= 1024 * 1024) state.response = text;
  }

  const fetch = window.fetch;
  window.fetch = function (...args) {
    const pending = fetch.apply(this, args);
    void pending.then(response => {
      if (response.ok && isRoomResponse(response.url)) return response.clone().json().then(save);
    }).catch(() => {});
    return pending;
  };

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      if (this.status !== 200 || !isRoomResponse(this.responseURL)) return;
      try {
        save(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
      } catch { /* the website may return a non-JSON response */ }
    }, { once: true });
    return send.apply(this, args);
  };

  document.addEventListener('play', event => {
    if (event.target instanceof HTMLMediaElement) event.target.muted = true;
  }, true);
})();
