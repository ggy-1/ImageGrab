/**
 * lib/image-utils.js
 * ---------------------------------------------------------------------------
 * 纯函数工具库（不依赖 DOM、不依赖 chrome API），三处共用，保证逻辑只有一份：
 *   1. content script —— manifest 中先于 content.js 注入，挂载到 window.EMIUtils
 *   2. service worker —— background.js 顶部 importScripts('lib/image-utils.js')
 *   3. Node 单元测试 —— UMD 形式导出 module.exports
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  var api = factory();
  if (root) root.EMIUtils = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 图片扩展名（含可选查询串/哈希） */
  var IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|avif|jfif)(?=$|[?#])/i;

  /** 这些协议不是真实可下载的图片地址 */
  var BAD_SCHEME_RE = /^(data|blob|javascript|about|chrome|chrome-extension|filesystem|ws|wss):/i;

  /**
   * 明确属于「非商品图」的关键词：图标 / 占位 / 埋点 / 验证码 / 水印等。
   * 只收录极少出现在真实商品图文件名里的词，避免误杀。
   */
  var HARD_BAD_KEYWORDS = [
    'logo', 'icon', 'sprite', 'avatar', 'qrcode', 'qr_code', 'blank.gif', 'blank.png',
    'placeholder', 'spacer', 'pixel.gif', '1x1', 'loading.gif', 'watermark',
    'captcha', 'nocaptcha', 'spacer.gif', 'transparent.gif', 'noscript.gif'
  ];

  /** 统计埋点 / 无关主机名（部分为 URL 片段匹配，不要求是完整主机名） */
  var BAD_HOST_KEYWORDS = [
    'hm.baidu.com', 'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
    'cnzz.com', 'umeng.com', 'talkingdata', 'sentry.io', 'beacon', 'log.mmstat',
    'static.zhihu.com', 'analytics', 'monitor', 'turing.captcha', 'punish'
  ];

  /* ------------------------------------------------------------------ *
   * 基础判断
   * ------------------------------------------------------------------ */

  /** 是否是可直接访问的 http(s) 地址 */
  function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  /** 是否是 data: / blob: 等不可下载的地址 */
  function isBadScheme(url) {
    return typeof url !== 'string' || url === '' || BAD_SCHEME_RE.test(url);
  }

  /** 把任意「可能带引号/带 url() 包装」的字符串清洗成裸 URL */
  function unwrapUrl(raw) {
    if (typeof raw !== 'string') return '';
    var s = raw.trim();
    // 去掉 CSS url(...) 包装
    var m = /^url\(\s*(.*?)\s*\)$/i.exec(s);
    if (m) s = m[1];
    // 去掉首尾引号
    s = s.replace(/^['"]|['"]$/g, '');
    // 还原 JSON 里被转义的斜杠 https:\/\/xxx
    s = s.replace(/\\\//g, '/');
    return s.trim();
  }

  /**
   * 把相对路径补全为绝对 URL
   * @param {string} raw      原始地址
   * @param {string} [baseHref] 基准地址（页面地址），默认 location.href
   * @returns {string|null} 绝对 URL，无法解析时返回 null
   */
  function normalizeUrl(raw, baseHref) {
    var s = unwrapUrl(raw);
    if (!s || s.length < 6) return null;
    if (isBadScheme(s)) return null;
    if (s.charAt(0) === '#') return null;

    if (/^https?:\/\//i.test(s)) return s;
    // 协议相对地址 //img.alicdn.com/xxx.jpg
    if (s.indexOf('//') === 0) return 'https:' + s;

    var base = baseHref || (typeof location !== 'undefined' ? location.href : 'https://example.com/');
    try {
      var u = new URL(s, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.href;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 平台差异兼容：把缩略图地址升级成原图地址
   * ------------------------------------------------------------------ */

  /**
   * 淘宝 / 天猫（alicdn、tbcdn、taobaocdn）的缩略图后缀规则：
   *   https://img.alicdn.com/imgextra/i1/123/O1CN01abc.jpg_430x430q90.jpg  -> .../O1CN01abc.jpg
   *   https://img.alicdn.com/imgextra/i1/123/O1CN01abc.jpg_.webp            -> .../O1CN01abc.jpg
   *   https://gw.alicdn.com/bao/uploaded/i3/x.jpg_Q75.jpg                   -> .../x.jpg
   */
  function upgradeTaobao(url) {
    return url.replace(/(\.(?:jpe?g|png|gif|webp|bmp|jfif))_[^/?#]*$/i, '$1');
  }

  /**
   * 京东（360buyimg、jdcdn）的缩略图前缀规则：
   *   //img14.360buyimg.com/n1/s450x450_jfs/t1/123/45/6789/12345/abc.jpg
   *   -> //img14.360buyimg.com/n0/jfs/t1/123/45/6789/12345/abc.jpg
   * n0 是京东的原图规格，sWxH_ 是缩放后缀。
   */
  function upgradeJd(url) {
    return url
      .replace(/\/s\d+x\d+_/i, '/')   // 去掉 s450x450_ 缩放后缀
      .replace(/\/n\d+\//i, '/n0/');  // n1/n12/... -> n0（原图）
  }

  /**
   * 拼多多 / 拼多多商家版（pddpic、yangkeduo）：
   *   https://img.pddpic.com/gaudit-image/x/abc.jpeg?imageMogr2/thumbnail/450x450
   *   https://t00img.yangkeduo.com/goods/images/xxx_450x450.jpg
   *   -> 去掉图片处理参数与尺寸后缀
   */
  function upgradePdd(url) {
    var out = url
      .replace(/([?&])(?:imageMogr2|imageView2|thumbnail)[^&#]*/gi, '$1')
      .replace(/[?&]$/, '');
    out = out.replace(/_{1,2}\d+x\d+(?:[a-z]*)?(\.(?:jpe?g|png|webp|gif|bmp|jfif))/i, '$1');
    out = out.replace(/-{1,2}\d+x\d+(?:[a-z]*)?(\.(?:jpe?g|png|webp|gif|bmp|jfif))/i, '$1');
    return out;
  }

  /**
   * 根据域名选择对应的原图还原策略；未命中任何平台时原样返回。
   * @param {string} url 绝对 URL
   * @returns {string} 原图 URL
   */
  function upgradeToOriginal(url) {
    if (!isHttpUrl(url)) return url;
    var out = url;
    try {
      if (/alicdn|tbcdn|taobaocdn|taobao\.com|tmall\.com/i.test(url)) {
        out = upgradeTaobao(out);
      } else if (/360buyimg|jdcdn|jd\.com/i.test(url)) {
        out = upgradeJd(out);
      } else if (/pddpic|yangkeduo|pinduoduo/i.test(url)) {
        out = upgradePdd(out);
      } else {
        // 未知域名：仍然尝试最常见的 _WxH 后缀
        out = upgradeTaobao(out);
      }
    } catch (e) {
      return url;
    }
    return out;
  }

  /**
   * 去重键：同一张图的不同尺寸 / 不同处理参数应当被视为同一张。
   * 规则：主机名（小写）+ 路径名，丢掉查询串与哈希。
   */
  function dedupeKey(url) {
    try {
      var u = new URL(url);
      return (u.hostname + u.pathname).toLowerCase();
    } catch (e) {
      return String(url).toLowerCase();
    }
  }

  /* ------------------------------------------------------------------ *
   * 从各种文本里抽取图片地址
   * ------------------------------------------------------------------ */

  /**
   * 解析 HTML 的 srcset 属性，返回按宽度倒序排列的候选地址。
   * 例： "a.jpg 300w, b.jpg 800w" / "a.jpg 1x, b.jpg 2x"
   */
  function parseSrcset(srcset) {
    var list = [];
    if (!srcset || typeof srcset !== 'string') return list;
    // srcset 里逗号既是分隔符又可能出现在 URL 中（极少见），按规范以「逗号 + 空白」为准
    var parts = srcset.split(/,(?=\s)/);
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim();
      if (!seg) continue;
      var bits = seg.split(/\s+/);
      var url = bits[0];
      var desc = bits[1] || '';
      var width = 0;
      if (/^\d+w$/i.test(desc)) width = parseInt(desc, 10);
      else if (/^\d+(\.\d+)?x$/i.test(desc)) width = Math.round(parseFloat(desc) * 1000);
      list.push({ url: url, width: width });
    }
    list.sort(function (a, b) { return b.width - a.width; });
    return list;
  }

  /** 从 CSS 值里抽出所有 url(...)，用于 background-image / border-image 等 */
  function extractUrlsFromCssValue(value) {
    var out = [];
    if (!value || typeof value !== 'string' || value === 'none') return out;
    var re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    var m;
    while ((m = re.exec(value)) !== null) {
      out.push(m[2].trim());
    }
    return out;
  }

  /**
   * 从 JS / JSON / CSS 文本中正则扫描图片地址。
   * 兼容被转义的斜杠（淘宝详情接口把 https:// 写成 https:\/\/）。
   */
  function extractUrlsFromText(text, limit) {
    var out = [];
    if (!text || typeof text !== 'string') return out;
    var max = limit || 500;
    var re = /(?:https?:)?(?:\\?\/){2}[^\s"'<>()]+?\.(?:jpe?g|png|webp|gif|bmp|avif|jfif)(?:\?[^\s"'<>()]*)?/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      out.push(m[0].replace(/\\\//g, '/'));
      if (out.length >= max) break;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 过滤规则
   * ------------------------------------------------------------------ */

  /** 根据 URL 特征判断是否明显不是商品图（图标 / 埋点 / 水印等） */
  function isLikelyNonProductImage(url) {
    if (!isHttpUrl(url)) return true;
    var lower = url.toLowerCase();

    // SVG 矢量图基本是页面 UI 元素，canvas 也无固定像素尺寸
    if (/\.svg(?=$|[?#])/i.test(lower)) return true;

    for (var i = 0; i < BAD_HOST_KEYWORDS.length; i++) {
      if (lower.indexOf(BAD_HOST_KEYWORDS[i]) !== -1) return true;
    }
    for (var j = 0; j < HARD_BAD_KEYWORDS.length; j++) {
      if (lower.indexOf(HARD_BAD_KEYWORDS[j]) !== -1) return true;
    }
    // 淘宝的 /tps/ 目录放的是页面 UI 切图（图标、按钮、背景）
    if (/\/tps\/i\d+\//i.test(lower)) return true;
    return false;
  }

  /** 尺寸是否达标（未知尺寸返回 true，交给后续探测决定） */
  function isSizeOk(width, height, minWidth, minHeight) {
    var w = Number(width) || 0;
    var h = Number(height) || 0;
    if (w <= 0 || h <= 0) return true;
    return w >= (minWidth || 0) && h >= (minHeight || 0);
  }

  /* ------------------------------------------------------------------ *
   * 其他
   * ------------------------------------------------------------------ */

  /** 从地址猜格式标签，用于界面展示 */
  function guessFormat(url) {
    var m = /\.(jpe?g|png|webp|gif|bmp|avif|jfif)(?=$|[?#])/i.exec(url || '');
    if (!m) return '未知';
    var ext = m[1].toLowerCase();
    if (ext === 'jpeg' || ext === 'jpg' || ext === 'jfif') return 'JPG';
    return ext.toUpperCase();
  }

  /** 从地址猜 MIME，用于修正 CDN 返回的 content-type */
  function guessMimeFromUrl(url) {
    var f = guessFormat(url);
    switch (f) {
      case 'JPG': return 'image/jpeg';
      case 'PNG': return 'image/png';
      case 'WEBP': return 'image/webp';
      case 'GIF': return 'image/gif';
      case 'BMP': return 'image/bmp';
      case 'AVIF': return 'image/avif';
      default: return '';
    }
  }

  /** 清理文件名前缀，去掉 Windows / macOS 不允许的字符 */
  function sanitizePrefix(prefix) {
    var s = String(prefix == null ? '' : prefix).trim();
    s = s.replace(/[\\/:*?"<>|\r\n\t]/g, '');
    s = s.replace(/\s+/g, '');
    if (!s) s = '商品图';
    return s.slice(0, 40);
  }

  /**
   * 生成下载文件名：商品图_001.png
   * @param {string} prefix 前缀
   * @param {number} index  序号（从 1 开始）
   * @param {number} [pad]  补零位数，默认 3
   * @param {string} [ext]  扩展名，默认 png
   */
  function buildFilename(prefix, index, pad, ext) {
    var p = sanitizePrefix(prefix);
    var n = Math.max(1, parseInt(index, 10) || 1);
    var digits = pad || 3;
    var num = String(n);
    while (num.length < digits) num = '0' + num;
    return p + '_' + num + '.' + (ext || 'png');
  }

  return {
    IMAGE_EXT_RE: IMAGE_EXT_RE,
    isHttpUrl: isHttpUrl,
    isBadScheme: isBadScheme,
    unwrapUrl: unwrapUrl,
    normalizeUrl: normalizeUrl,
    upgradeToOriginal: upgradeToOriginal,
    upgradeTaobao: upgradeTaobao,
    upgradeJd: upgradeJd,
    upgradePdd: upgradePdd,
    dedupeKey: dedupeKey,
    parseSrcset: parseSrcset,
    extractUrlsFromCssValue: extractUrlsFromCssValue,
    extractUrlsFromText: extractUrlsFromText,
    isLikelyNonProductImage: isLikelyNonProductImage,
    isSizeOk: isSizeOk,
    guessFormat: guessFormat,
    guessMimeFromUrl: guessMimeFromUrl,
    sanitizePrefix: sanitizePrefix,
    buildFilename: buildFilename
  };
});
