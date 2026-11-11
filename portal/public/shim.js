/**
 * 门户运行时补丁（注入到每个游戏页面最前面）
 * ---------------------------------------------------------------
 * 游戏原本是「站点根目录」思维写的：/js/main.js、/socket.io/、ws://host/ws …
 * 现在它们统一挂在 /play/<slug>/ 之下，这里把运行期发起的根路径请求改写到子路径，
 * 游戏源码一行都不用改。
 */
(function () {
  var BASE = window.__PORTAL_BASE__;
  if (!BASE || typeof BASE !== 'string') return;
  BASE = BASE.replace(/\/+$/, '');

  function inBase(p) {
    return p === BASE || p.indexOf(BASE + '/') === 0;
  }

  function fix(u) {
    if (typeof u !== 'string' || !u) return u;
    if (/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(u)) return u;

    // 绝对 URL（含 ws:// wss:// http:// https://）
    var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)\/\/([^\/?#]+)([^?#]*)([\s\S]*)$/.exec(u);
    if (m) {
      var p = m[3] || '/';
      if (inBase(p)) return u;
      if (p.charAt(0) !== '/') p = '/' + p;
      return m[1] + '//' + m[2] + BASE + p + m[4];
    }

    // 协议相对 //host/path
    if (u.indexOf('//') === 0) return u;

    if (u.charAt(0) === '/') return inBase(u) ? u : BASE + u;
    return u; // 相对路径交给 <base> 处理
  }

  /* ---------- 网络 API ---------- */
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && XHR.prototype.open) {
    var rawOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = fix(url);
      return rawOpen.apply(this, args);
    };
  }

  if (window.fetch) {
    var rawFetch = window.fetch;
    /* ★ 保留原生 fetch：下面心跳要用它打网关根路径，
       否则会被这里的前缀改写打到 /play/<slug>/api/heartbeat（502）。 */
    window.__PORTAL_RAW_FETCH__ = function (u, o) { return rawFetch.call(window, u, o); };
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') input = fix(input);
        else if (input && typeof input.url === 'string') input = new Request(fix(input.url), input);
      } catch (e) { /* 保持原样 */ }
      return rawFetch.call(this, input, init);
    };
  }

  var NativeWS = window.WebSocket;
  if (NativeWS) {
    function WS(url, protocols) {
      return new NativeWS(fix(String(url)), protocols);
    }
    WS.prototype = NativeWS.prototype;
    WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
    window.WebSocket = WS;
  }

  if (window.EventSource) {
    var NativeES = window.EventSource;
    function ES(url, opts) { return new NativeES(fix(String(url)), opts); }
    ES.prototype = NativeES.prototype;
    ES.CONNECTING = 0; ES.OPEN = 1; ES.CLOSED = 2;
    window.EventSource = ES;
  }

  if (navigator.sendBeacon) {
    var rawBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { return rawBeacon(fix(url), data); };
  }

  /* ---------- 资源元素属性 ---------- */
  function patchProp(ctor, prop) {
    if (!ctor || !ctor.prototype) return;
    try {
      var desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
      if (!desc || !desc.set) return;
      Object.defineProperty(ctor.prototype, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) { desc.set.call(this, fix(v)); }
      });
    } catch (e) { /* ignore */ }
  }

  [window.HTMLImageElement, window.HTMLScriptElement, window.HTMLIFrameElement,
   window.HTMLAudioElement, window.HTMLVideoElement, window.HTMLSourceElement,
   window.HTMLEmbedElement, window.HTMLTrackElement].forEach(function (c) {
    patchProp(c, 'src');
  });
  patchProp(window.HTMLLinkElement, 'href');
  patchProp(window.HTMLObjectElement, 'data');

  if (window.Element && Element.prototype.setAttribute) {
    var rawSet = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var n = String(name).toLowerCase();
      if (n === 'src' || n === 'href' || n === 'poster' || n === 'data') value = fix(value);
      return rawSet.call(this, name, value);
    };
  }

  if (window.Audio) {
    var NativeAudio = window.Audio;
    function Audio(src) {
      var el = new NativeAudio();
      if (src != null) el.src = fix(String(src));
      return el;
    }
    Audio.prototype = NativeAudio.prototype;
    window.Audio = Audio;
  }

  /* ---------- CSS url() 在部分浏览器里不走属性 setter，补一层 ---------- */
  if (window.CSSStyleSheet && CSSStyleSheet.prototype.insertRule) {
    // 通常由网关直接改写 CSS 文本，这里只做兜底，不改行为
  }

  // 方便排查：控制台可查当前游戏挂载点
  window.__PORTAL_INFO__ = { base: BASE };

  /* ---------- 在线状态上报：让监控台知道这台设备正在玩哪个游戏 ---------- */
  try {
    var slug = BASE.replace(/^\/play\//, '').replace(/\/.*$/, '') || 'unknown';
    var getSid = function () {
      try {
        var k = 'pz_sid', v = localStorage.getItem(k);
        if (!v) {
          v = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
          localStorage.setItem(k, v);
        }
        return v;
      } catch (e) {
        return 'u' + Math.random().toString(36).slice(2, 12);
      }
    };
    var sid = getSid();
    var beat = function () {
      try {
        /* ★ 用原生 fetch 打网关根路径：window.fetch 已被 shim 改写，
           会把 /api/heartbeat 加前缀变成 /play/<slug>/api/heartbeat → 502。 */
        var rf = window.__PORTAL_RAW_FETCH__ || window.fetch;
        rf('/api/heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ where: slug, sid: sid }),
          cache: 'no-store'
        }).catch(function () {});
      } catch (e) {}
    };
    beat();
    setInterval(beat, 8000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) beat(); });
  } catch (e) {}
})();
