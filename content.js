/**
 * content.js
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 判断当前页面是否为「淘宝 / 天猫 / 京东 / 拼多多（含商家版）」的商品详情页，
 *      是则在右下角注入悬浮按钮「获取图片」，不是则不注入；
 *   2. 点击按钮后滚动页面触发懒加载，再扫描页面上所有商品图片：
 *      <img src / srcset / data-src / data-lazy-src / 任意 data-* 图片属性>、
 *      <picture><source srcset>、背景图 background-image、
 *      <style> 与 <script> 内联文本中的图片地址；
 *   3. 平台差异兼容：把缩略图地址升级为原图地址（阿里 / 京东 / 拼多多规则不同）；
 *   4. 过滤图标、占位图、1x1 像素图、小于 100x100 的图片，补全绝对地址并去重；
 *   5. 通过 chrome.runtime.sendMessage 把结果交给 Service Worker，由它打开预览页。
 *
 * 注意：按钮样式通过 Shadow DOM + 构造样式表注入，页面 CSS 无法影响按钮，
 *      按钮也不会影响页面原有布局与操作。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  // 只注入最顶层文档，避免 iframe 内重复注入
  if (window.top !== window) return;
  if (window.__EMI_CONTENT_LOADED__) return;
  window.__EMI_CONTENT_LOADED__ = true;

  var U = window.EMIUtils; // 由 lib/image-utils.js 提供
  if (!U) return;

  /* ======================= 1. 配置 ======================= */

  var CONFIG = {
    MIN_WIDTH: 100,          // 最小宽度（像素），小于则丢弃
    MIN_HEIGHT: 100,         // 最小高度（像素），小于则丢弃
    MAX_BACKGROUND_SCAN: 4000, // 背景图最多扫描的元素数量（性能保护）
    MAX_REGEX_CANDIDATES: 500, // 内联脚本/样式里最多取多少个候选地址
    MAX_PROBE: 400,          // 尺寸未知时最多在线探测多少张图
    PROBE_CONCURRENCY: 8,    // 探测并发数
    PROBE_TIMEOUT: 8000,     // 单张探测超时（毫秒）
    AUTO_SCROLL: true,       // 自动滚动页面触发懒加载
    AUTO_SCROLL_STEP_MS: 160,
    AUTO_SCROLL_MAX_MS: 6000,
    DEBUG_ALWAYS_SHOW: false // true = 平台域名下所有页面都显示按钮（调试用）
  };

  var HOST_ID = 'emi-floating-root';
  var PLATFORM = detectPlatform();
  var ui = null;         // UI 引用集合
  var scanning = false;  // 防止重复点击

  /* ======================= 2. 平台与页面判定 ======================= */

  /** 识别当前平台：taobao / jd / pdd / null */
  function detectPlatform() {
    var h = location.hostname;
    if (/(^|\.)taobao\.com$/i.test(h) || /(^|\.)tmall\.com$/i.test(h)) return 'taobao';
    if (/(^|\.)jd\.com$/i.test(h)) return 'jd';
    if (/(^|\.)pinduoduo\.com$/i.test(h) || /(^|\.)yangkeduo\.com$/i.test(h)) return 'pdd';
    return null;
  }

  /** 明确的「非详情页」URL 特征：登录、搜索、购物车、订单等页面不注入按钮 */
  var NOT_DETAIL_URL_RE = /\/(?:login|logout|passport|register|signin|captcha|verify|cart|carts|order|orders|pay|payment|search|list|help|rule|notice|message|chat|setting|settings|profile|account|feedback|download|apply)(?:[/?#.]|$)/i;

  /** 明确的功能型子域名（登录、支付、购物车等），这些域名下不注入按钮 */
  var NOT_DETAIL_HOST_RE = /(^|\.)(login|logout|passport|signin|auth|sso|cart|order|pay|payment|search|member|reg|my|message|health|err)\./i;

  /** 各平台的「详情页」URL 特征 */
  var DETAIL_URL_RES = [
    /item\.taobao\.com\/item\.htm/i,
    /detail\.tmall\.(?:com|hk)\/item\.htm/i,
    /item\.tmall\.com\/item\.htm/i,
    /(?:item|detail)\.(?:taobao|tmall|jd)\.com/i,
    /item\.jd\.com\/\d+\.html/i,
    /item\.jd\.hk\/\d+\.html/i,
    /(?:mobile|m)\.yangkeduo\.com\/goods(?:_detail)?\.html/i,
    /yangkeduo\.com\/goods/i,
    /\/goods\.html/i,
    /\/goods\/\d+/i,
    /mms\.pinduoduo\.com\/(?:goods|product|sale)/i,
    /shop\.jd\.com\/\S*(?:product|item|sku)/i
  ];

  /** 各平台详情页的 DOM 特征（懒渲染 / 有兜底作用） */
  var DETAIL_SELECTORS = [
    '#J_DetailMeta', '#J_ImgBooth', '.tb-detail-hd', '.tb-main-pic', '.tb-gallery',
    '#detail', '.tb-detail', '[class*="ItemHeader"]', '[class*="itemImage"]',
    '#spec-img', '#choose-attrs', '.sku-name', '.product-intro', '#crumb-wrap', '.p-price',
    '[class*="goods-detail"]', '[class*="goodsDetail"]', '.goods-name', '#goodsDetail',
    '[data-testid*="goods"]', '.goods-detail-pic', '.detail-pic'
  ];

  /** 页面上「大图」数量统计，用于最终兜底判断 */
  function countLargeImages() {
    var imgs = document.images || [];
    var n = 0;
    for (var i = 0; i < imgs.length; i++) {
      var w = imgs[i].naturalWidth || imgs[i].width || 0;
      var h = imgs[i].naturalHeight || imgs[i].height || 0;
      if (w >= 300 && h >= 300) n++;
      if (n >= 3) return n;
    }
    return n;
  }

  /**
   * 是否为商品详情页。判定顺序：URL 反例 -> URL 正例 -> DOM 特征 -> 大图数量兜底。
   * 属于启发式判断，可通过 CONFIG.DEBUG_ALWAYS_SHOW 强制显示。
   */
  function isProductDetailPage() {
    if (CONFIG.DEBUG_ALWAYS_SHOW) return true;
    if (!PLATFORM) return false;

    // 0) 登录 / 支付 / 购物车等功能页直接排除
    if (NOT_DETAIL_HOST_RE.test(location.hostname)) return false;

    var url = location.href;
    // SPA 页面用 hash 路由，拼上 hash 一起判断
    var full = url + location.hash;

    // 1) 反例优先：登录 / 搜索 / 购物车 / 订单 / 列表等功能页先排除，
    //    但商家后台（拼多多 mms、京东京麦）的商品编辑页路径里也可能含这些词，
    //    所以给一次「DOM 特征 + 大图数量」的翻案机会。
    if (NOT_DETAIL_URL_RE.test(location.pathname)) {
      return hasDetailMarker() && countLargeImages() >= 2;
    }
    // 2) 详情页 URL 正例
    for (var i = 0; i < DETAIL_URL_RES.length; i++) {
      if (DETAIL_URL_RES[i].test(full)) return true;
    }
    // 3) URL 没有明显特征时看 DOM
    if (hasDetailMarker()) return true;
    return countLargeImages() >= 3;
  }

  function hasDetailMarker() {
    for (var i = 0; i < DETAIL_SELECTORS.length; i++) {
      try {
        if (document.querySelector(DETAIL_SELECTORS[i])) return true;
      } catch (e) { /* 选择器兼容性保护 */ }
    }
    return false;
  }

  /* ======================= 3. UI（悬浮按钮 + 轻提示） ======================= */

  function createUI() {
    var host = document.createElement('div');
    host.id = HOST_ID;
    // 关键定位样式直接用 CSSOM 设置：即使页面 CSP 很严格也不会被拦截
    var st = host.style;
    st.setProperty('position', 'fixed');
    st.setProperty('right', '24px');
    st.setProperty('bottom', '28px');
    st.setProperty('z-index', '2147483000');
    st.setProperty('width', 'auto');
    st.setProperty('height', 'auto');
    st.setProperty('margin', '0');
    st.setProperty('padding', '0');

    var shadow = host.attachShadow({ mode: 'open' });

    // 注意：markup 中不写任何 style 属性，避免被页面 CSP 的 style-src 拦截
    shadow.innerHTML = [
      '<div class="emi-wrap">',
      '  <div class="emi-toast" role="status" aria-live="polite" hidden></div>',
      '  <button class="emi-fab" type="button" title="提取本页全部商品图片">',
      '    <span class="emi-fab__spinner" aria-hidden="true"></span>',
      '    <span class="emi-fab__icon" aria-hidden="true">',
      '      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"',
      '           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '        <path d="M12 3v11"></path><path d="M7 9.5l5 5 5-5"></path><path d="M4 20h16"></path>',
      '      </svg>',
      '    </span>',
      '    <span class="emi-fab__text">',
      '      <span class="emi-fab__label">获取图片</span>',
      '      <span class="emi-fab__sub">扫描本页商品图</span>',
      '    </span>',
      '    <span class="emi-fab__badge" hidden>0</span>',
      '  </button>',
      '</div>'
    ].join('\n');

    var btn = shadow.querySelector('.emi-fab');
    var label = shadow.querySelector('.emi-fab__label');
    var sub = shadow.querySelector('.emi-fab__sub');
    var badge = shadow.querySelector('.emi-fab__badge');
    var toast = shadow.querySelector('.emi-toast');
    var toastTimer = null;

    btn.addEventListener('click', function () { startScan(); });

    ui = {
      host: host,
      shadow: shadow,
      btn: btn,
      label: label,
      sub: sub,
      badge: badge,
      toast: toast,
      showToast: function (text, type) {
        toast.textContent = text;
        toast.className = 'emi-toast emi-toast--' + (type || 'info');
        toast.hidden = false;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
          toast.hidden = true;
        }, type === 'error' ? 6000 : 3600);
      },
      setBusy: function (busy, text, subText) {
        btn.classList.toggle('emi-fab--busy', !!busy);
        btn.disabled = !!busy;
        if (text) label.textContent = text;
        if (typeof subText === 'string') sub.textContent = subText;
      },
      setBadge: function (n) {
        if (n > 0) {
          badge.textContent = n > 999 ? '999+' : String(n);
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      }
    };

    (document.body || document.documentElement).appendChild(host);
    loadStyles(shadow);
    return ui;
  }

  /**
   * 加载 content.css：
   *   主方案 —— fetch 扩展资源 + 构造样式表（CSSStyleSheet），
   *             构造样式表属于 CSSOM，不受页面 CSP 的 style-src 限制；
   *   兜底方案 —— <link> 引入（个别环境下 fetch 扩展资源失败时使用）。
   */
  function loadStyles(shadow) {
    var url = chrome.runtime.getURL('content.css');
    var canFetch = typeof fetch === 'function';
    if (canFetch && typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadow) {
      try {
        fetch(url)
          .then(function (r) { return r.text(); })
          .then(function (css) {
            var sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            shadow.adoptedStyleSheets = [sheet];
          })
          .catch(function () { fallbackLink(); });
      } catch (e) {
        fallbackLink();
      }
    } else {
      fallbackLink();
    }
    function fallbackLink() {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      shadow.appendChild(link);
    }
  }

  function removeUI() {
    if (ui && ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui = null;
  }

  /* ======================= 4. 注入时机与 SPA 路由监听 ======================= */

  var lastHref = location.href;

  function syncButtonVisibility() {
    var shouldShow = !!PLATFORM && isProductDetailPage();
    if (shouldShow && !ui) createUI();
    if (!shouldShow && ui) removeUI();
  }

  function boot() {
    syncButtonVisibility();

    // 详情页内容常常是懒渲染的，首次判定失败时多试几次；同时监听 SPA 路由变化。
    // recheckBudget 限制「未显示按钮」时的重复探测次数，避免在非详情页上长期消耗性能。
    var recheckBudget = 20;
    setInterval(function () {
      if (location.href !== lastHref) {
        lastHref = location.href;
        recheckBudget = 20;
        syncButtonVisibility();
        return;
      }
      if (!ui && PLATFORM && recheckBudget > 0) {
        recheckBudget--;
        syncButtonVisibility();
      }
    }, 2000);

    ['pushState', 'replaceState'].forEach(function (name) {
      var orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function () {
        var ret = orig.apply(this, arguments);
        setTimeout(function () {
          recheckBudget = 20;
          syncButtonVisibility();
        }, 500);
        return ret;
      };
    });
    window.addEventListener('popstate', function () {
      setTimeout(function () {
        recheckBudget = 20;
        syncButtonVisibility();
      }, 500);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* ======================= 5. 懒加载触发 ======================= */

  /** 自动向下滚动页面（并滚回原位），触发懒加载图片真正加载出来 */
  function autoScrollPage() {
    return new Promise(function (resolve) {
      var startY = window.scrollY || window.pageYOffset || 0;
      var total = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      var viewport = window.innerHeight || 800;
      var step = Math.max(200, Math.round(viewport * 0.85));
      var maxSteps = Math.ceil((total - viewport) / step);
      if (maxSteps <= 1 || total <= viewport + 100) { resolve(); return; }

      var steps = Math.min(maxSteps, Math.ceil(CONFIG.AUTO_SCROLL_MAX_MS / CONFIG.AUTO_SCROLL_STEP_MS));
      var i = 0;
      var timer = setInterval(function () {
        i++;
        try { window.scrollTo(0, Math.min(total, i * step)); } catch (e) { /* ignore */ }
        if (i >= steps) {
          clearInterval(timer);
          try { window.scrollTo(0, startY); } catch (e) { /* ignore */ }
          // 给浏览器一点时间完成图片解码
          setTimeout(resolve, 400);
        }
      }, CONFIG.AUTO_SCROLL_STEP_MS);
    });
  }

  /* ======================= 6. 图片采集 ======================= */

  /**
   * 从 DOM 中同步采集所有候选图片（不做在线尺寸探测）。
   * @returns {Array<Object>} 记录数组 {id,url,thumb,width,height,sources}
   */
  function collectCandidatesFromDom() {
    var map = new Map();

    function push(rawUrl, meta) {
      var url = U.normalizeUrl(rawUrl, location.href);
      if (!url) return;
      var best = U.upgradeToOriginal(url);          // 下载用：原图
      var key = U.dedupeKey(best);
      var rec = map.get(key);
      if (!rec) {
        rec = {
          id: 'img_' + (map.size + 1) + '_' + Math.random().toString(36).slice(2, 7),
          url: best,
          thumb: url,                                // 展示用：页面上的地址，加载更快
          width: 0,
          height: 0,
          sources: []
        };
        map.set(key, rec);
      }
      var w = Number(meta && meta.width) || 0;
      var h = Number(meta && meta.height) || 0;
      if (w * h > rec.width * rec.height) {          // 保留更大的尺寸信息
        rec.width = w;
        rec.height = h;
      }
      if (meta && meta.source && rec.sources.indexOf(meta.source) === -1) {
        rec.sources.push(meta.source);
      }
      // 若当前展示地址尚未设置（首次为空），补上
      if (!rec.thumb) rec.thumb = url;
    }

    collectFromImgTags(push);
    collectFromPictureSources(push);
    collectFromBackgrounds(push);
    collectFromInlineCode(push);

    return Array.from(map.values());
  }

  /** <img>：src、currentSrc、srcset、各类 data-* 懒加载属性（含未知 data 属性的通用兜底） */
  function collectFromImgTags(push) {
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var w = img.naturalWidth || Number(img.getAttribute('width')) || 0;
      var h = img.naturalHeight || Number(img.getAttribute('height')) || 0;
      if (!w || !h) {
        // 元素在页面上占据的尺寸也是很可靠的参考
        var r = img.getBoundingClientRect();
        if (!w) w = Math.round(r.width) || Number(img.getAttribute('data-width')) || 0;
        if (!h) h = Math.round(r.height) || Number(img.getAttribute('data-height')) || 0;
      }
      var meta = { width: w, height: h, source: 'img' };

      if (img.currentSrc) push(img.currentSrc, meta);
      if (img.src) push(img.src, meta);
      if (img.getAttribute('src')) push(img.getAttribute('src'), meta);

      // srcset / data-srcset：只取宽度最大的候选，避免同一张图的不同分辨率挤满结果
      var srcset = img.getAttribute('srcset');
      if (srcset) {
        var topSrcset = U.parseSrcset(srcset)[0];
        if (topSrcset) push(topSrcset.url, { width: w, height: h, source: 'srcset' });
      }
      var dataSrcset = img.getAttribute('data-srcset');
      if (dataSrcset) {
        var topDataSrcset = U.parseSrcset(dataSrcset)[0];
        if (topDataSrcset) push(topDataSrcset.url, { width: 0, height: 0, source: 'data-srcset' });
      }

      // 已知的懒加载属性（各家命名不同，逐个兜住）
      var lazyAttrs = [
        'data-src', 'data-lazy-src', 'data-original', 'data-original-src', 'data-ks-lazyload',
        'data-lazyload', 'data-lazysrc', 'data-echo', 'data-url', 'data-image', 'data-img',
        'data-src-big', 'data-big-src', 'data-large', 'data-pic', 'data-pic-url', 'data-img-url',
        '_src', 'data-origin-src', 'data-actualsrc', 'data-real-src'
      ];
      for (var a = 0; a < lazyAttrs.length; a++) {
        var v = img.getAttribute(lazyAttrs[a]);
        if (v) push(v, { width: 0, height: 0, source: 'lazy:' + lazyAttrs[a] });
      }

      // 通用兜底：任何取值形如图片地址的 data-* 属性都收进来（应对平台改属性名）
      var attrs = img.attributes || [];
      for (var b = 0; b < attrs.length; b++) {
        var name = attrs[b].name;
        var val = attrs[b].value;
        if (!name || !val || name === 'src' || name === 'srcset') continue;
        if (name.indexOf('data-') !== 0 && name !== '_src') continue;
        if (!U.IMAGE_EXT_RE.test(val)) continue; // 只接受确实以图片扩展名结尾的取值
        push(val, { width: 0, height: 0, source: 'attr:' + name });
      }
    }
  }

  /** <picture> 里的 <source srcset>（往往是大图，取宽度最大的一个） */
  function collectFromPictureSources(push) {
    var sources = document.querySelectorAll('source[srcset], source[data-srcset]');
    for (var i = 0; i < sources.length; i++) {
      var ss = sources[i].getAttribute('srcset') || sources[i].getAttribute('data-srcset');
      if (!ss) continue;
      var largest = U.parseSrcset(ss)[0];
      if (largest) push(largest.url, { width: 0, height: 0, source: 'source' });
    }
  }

  /** 背景图：只挑可能承载商品图的元素，避免全量遍历拖慢页面 */
  function collectFromBackgrounds(push) {
    var els = [];
    // 1) 内联写了 url(...) 的元素
    try {
      els = els.concat(Array.prototype.slice.call(document.querySelectorAll('[style*="url("]')));
    } catch (e) { /* ignore */ }
    // 2) 常见详情页容器内部的所有元素
    var containers = [
      '#detail', '#J_DetailMeta', '.tb-detail', '[class*="detail"]', '[class*="Detail"]',
      '[class*="gallery"]', '[class*="Gallery"]', '[class*="swiper"]', '[class*="carousel"]',
      '[class*="spec"]', '[class*="pic"]', '[class*="Pic"]'
    ];
    for (var c = 0; c < containers.length && els.length < CONFIG.MAX_BACKGROUND_SCAN; c++) {
      try {
        var found = document.querySelectorAll(containers[c] + ' *');
        for (var f = 0; f < found.length && els.length < CONFIG.MAX_BACKGROUND_SCAN; f++) {
          els.push(found[f]);
        }
      } catch (e) { /* ignore */ }
    }
    // 3) 还是不够就兜底全量扫（受 MAX_BACKGROUND_SCAN 限制）
    if (els.length < 200) {
      try {
        var all = document.querySelectorAll('div, section, li, a, span, td');
        for (var k = 0; k < all.length && els.length < CONFIG.MAX_BACKGROUND_SCAN; k++) els.push(all[k]);
      } catch (e) { /* ignore */ }
    }

    var seen = new Set();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || el.nodeType !== 1 || seen.has(el)) continue;
      seen.add(el);
      var bg;
      try { bg = getComputedStyle(el).backgroundImage; } catch (e) { continue; }
      if (!bg || bg === 'none') continue;
      var urls = U.extractUrlsFromCssValue(bg);
      if (!urls.length) continue;
      var rect = el.getBoundingClientRect();
      var w = Math.round(rect.width);
      var h = Math.round(rect.height);
      for (var u = 0; u < urls.length; u++) {
        push(urls[u], { width: w, height: h, source: 'background' });
      }
    }
  }

  /**
   * 内联 <script> / <style> 文本里的图片地址。
   * 淘宝、京东详情数据常以 JSON 内联在 script 中，图片还没进 DOM，
   * 这一步可以提前把地址捞出来（尺寸稍后由探测补上）。
   */
  function collectFromInlineCode(push) {
    var blocks = [];
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length && blocks.length < 30; i++) {
      var t = scripts[i].textContent;
      if (t && t.length > 60 && /jpe?g|png|webp/i.test(t)) blocks.push(t.slice(0, 600000));
    }
    var styles = document.querySelectorAll('style');
    for (var j = 0; j < styles.length && blocks.length < 40; j++) {
      var st = styles[j].textContent;
      if (st && /url\(/i.test(st)) blocks.push(st.slice(0, 300000));
    }

    var picked = 0;
    for (var b = 0; b < blocks.length && picked < CONFIG.MAX_REGEX_CANDIDATES; b++) {
      var urls = U.extractUrlsFromText(blocks[b], CONFIG.MAX_REGEX_CANDIDATES - picked);
      for (var u = 0; u < urls.length; u++) {
        push(urls[u], { width: 0, height: 0, source: 'inline-code' });
        picked++;
      }
    }
  }

  /* ======================= 7. 过滤 + 尺寸探测 ======================= */

  /** 静态过滤：URL 特征过滤 + 已知尺寸过滤 */
  function applyStaticFilters(records) {
    return records.filter(function (r) {
      if (!U.isHttpUrl(r.url)) return false;
      if (U.isLikelyNonProductImage(r.url)) return false;
      return true;
    });
  }

  /** 在线加载单张图片，取回真实尺寸 */
  function probeImageSize(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () { finish(false); }, CONFIG.PROBE_TIMEOUT);

      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(ok ? { width: img.naturalWidth, height: img.naturalHeight } : null);
      }
      img.onload = function () { finish(img.naturalWidth > 0); };
      img.onerror = function () { finish(false); };
      try { img.src = url; } catch (e) { finish(false); }
    });
  }

  /** 并发探测一批尺寸未知的图片，onProgress 用于按钮上显示进度 */
  async function probeUnknownSizes(records, onProgress) {
    // 超过 MAX_PROBE 的部分不再联网探测（性能保护），保留为「尺寸未知」
    var queue = records.slice(0, CONFIG.MAX_PROBE);
    var skipped = records.slice(CONFIG.MAX_PROBE);
    var results = [];
    var index = 0;
    var finished = 0;

    async function worker() {
      while (index < queue.length) {
        var rec = queue[index++];
        if (rec.width > 0 && rec.height > 0) {
          results.push(rec);
        } else {
          var size = await probeImageSize(rec.thumb || rec.url);
          if (size && size.width > 0) {
            rec.width = size.width;
            rec.height = size.height;
            rec.sources.push('probe');
          }
          results.push(rec);
        }
        finished++;
        if (onProgress && finished % 3 === 0) onProgress(finished, queue.length);
      }
    }

    var workers = [];
    for (var i = 0; i < CONFIG.PROBE_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
    if (onProgress) onProgress(finished, queue.length);
    return results.concat(skipped);
  }

  /**
   * 完整流程：采集 -> 过滤 -> 探测尺寸 -> 再过滤 -> 排序
   * @param {Function} [onProgress] (done,total) 探测进度回调
   */
  async function collectImages(onProgress) {
    var raw = collectCandidatesFromDom();
    var kept = applyStaticFilters(raw);

    // 已知尺寸的立即判定；未知尺寸的交给探测
    var known = [];
    var unknown = [];
    kept.forEach(function (r) {
      if (r.width > 0 && r.height > 0) known.push(r);
      else unknown.push(r);
    });

    var probed = await probeUnknownSizes(unknown, onProgress);
    var all = known.concat(probed);

    var final = all.filter(function (r) {
      if (U.isLikelyNonProductImage(r.url)) return false;
      // 尺寸未知（探测失败，通常是因为图片仍处于未加载状态）时按「不小于最小边」保守放行
      if (!(r.width > 0 && r.height > 0)) return true;
      if (r.width < CONFIG.MIN_WIDTH || r.height < CONFIG.MIN_HEIGHT) return false;
      // 1x1 像素图（像素级埋点）
      if (r.width * r.height <= 16) return false;
      return true;
    });

    final.sort(function (a, b) {
      return (b.width * b.height) - (a.width * a.height);
    });
    // 过滤后重新编号，保证序号连续
    final.forEach(function (r, i) { r.index = i + 1; });
    return final;
  }

  /* ======================= 8. 主流程 ======================= */

  function friendlyError(err) {
    var msg = (err && (err.message || err.toString())) || '未知错误';
    if (/Extension context invalidated|message port closed|Receiving end does not exist/i.test(msg)) {
      return '扩展已更新或重新加载，请刷新页面后重试';
    }
    return msg;
  }

  async function startScan() {
    if (scanning) return;
    scanning = true;
    var uiRef = ui;
    if (!uiRef) { scanning = false; return; }

    uiRef.setBusy(true, '正在扫描…', '准备中');
    try {
      // 1) 触发懒加载
      if (CONFIG.AUTO_SCROLL) {
        uiRef.setBusy(true, '正在扫描…', '滚动加载懒加载图');
        await autoScrollPage();
      }
      // 2) 采集 + 过滤
      uiRef.setBusy(true, '正在扫描…', '解析图片地址');
      var images = await collectImages(function (done, total) {
        if (ui) ui.setBusy(true, '校验尺寸…', done + ' / ' + total);
      });

      if (!images.length) {
        uiRef.showToast('未找到符合条件的商品图片（已过滤图标与小于 ' +
          CONFIG.MIN_WIDTH + '×' + CONFIG.MIN_HEIGHT + ' 的图片）', 'warn');
        return;
      }

      // 3) 交给 Service Worker，由它保存会话并打开预览页
      uiRef.setBusy(true, '正在发送…', '打开预览页');
      var res = await chrome.runtime.sendMessage({
        type: 'EMI_IMAGES_FOUND',
        payload: {
          images: images,
          pageUrl: location.href,
          pageTitle: document.title,
          platform: PLATFORM
        }
      });
      if (!res || !res.ok) throw new Error((res && res.error) || '后台没有响应');

      uiRef.setBadge(images.length);
      uiRef.showToast('已提取 ' + images.length + ' 张图片，正在打开预览页', 'ok');
      uiRef.setBusy(false, '获取图片', '已提取 ' + images.length + ' 张');
    } catch (err) {
      uiRef.showToast('提取失败：' + friendlyError(err), 'error');
      uiRef.setBusy(false, '获取图片', '扫描本页商品图');
    } finally {
      scanning = false;
    }
  }

  /** 预览页点击「重新获取」时由 Service Worker 转发过来 */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'EMI_RESCAN') return;
    // 若按钮因页面结构变化被移除，先补回来
    if (!ui) createUI();
    startScan().then(function () {
      sendResponse({ ok: true });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true; // 异步响应
  });

  /* ======================= 9. 调试 / 测试入口 ======================= */
  // 挂在 content script 的隔离环境里，便于在 DevTools 切换到扩展上下文后手动验证；
  // Node + jsdom 单元测试也通过它调用内部函数。
  window.EMI_DEBUG_API = {
    config: CONFIG,
    platform: PLATFORM,
    isProductDetailPage: isProductDetailPage,
    collectCandidatesFromDom: collectCandidatesFromDom,
    applyStaticFilters: applyStaticFilters,
    collectImages: collectImages,
    probeImageSize: probeImageSize,
    startScan: startScan,
    utils: U
  };
})();
