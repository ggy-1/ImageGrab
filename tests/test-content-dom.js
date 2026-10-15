/**
 * tests/test-content-dom.js
 * ---------------------------------------------------------------------------
 * 用 jsdom 模拟一个「天猫商品详情页」，直接加载真实的 lib/image-utils.js + content.js，
 * 验证：按钮注入、各类图片采集、干扰图过滤、去重、相对路径补全、消息发送。
 * 运行： node tests/test-content-dom.js
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const LIB_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'image-utils.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

const DETAIL_URL = 'https://detail.tmall.com/item.htm?id=999999999';
const LOGIN_URL = 'https://login.taobao.com/member/login.jhtml';
const OTHER_URL = 'https://example.com/product/1';

// 内联 JSON 中的图片地址（模拟详情接口把 https:// 转义成 https:\/\/）
const INLINE_JSON =
  'var __DETAIL__ = {"images":[{"pic":"https:\\/\\/img.alicdn.com\\/imgextra\\/i8\\/inline.jpg"}]};';

const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN"><head><title>测试商品详情页</title></head>
<body>
  <div id="detail">
    <img id="main" width="800" height="800" src="https://img.alicdn.com/imgextra/i1/main.jpg_430x430q90.jpg">
    <img width="800" height="800" src="https://img.alicdn.com/imgextra/i1/main.jpg_800x800q90.jpg">
    <img width="500" height="500" src="/imgextra/i9/relative.png">
    <img width="600" height="600" data-src="//img.alicdn.com/imgextra/i2/lazy.png">
    <img width="900" height="900" src="https://img.alicdn.com/imgextra/i3/small.jpg"
         srcset="https://img.alicdn.com/imgextra/i3/small.jpg 200w, https://img.alicdn.com/imgextra/i3/big.jpg 1200w">
    <img width="500" height="500" data-custom-lazy="https://img.alicdn.com/imgextra/i4/attr.jpg">
    <picture>
      <source srcset="https://img.alicdn.com/imgextra/i5/src.jpg 1600w">
      <img width="700" height="700" src="https://img.alicdn.com/imgextra/i5/fallback.jpg">
    </picture>
    <img width="1" height="1" src="https://img.alicdn.com/imgextra/pixel.gif">
    <img width="60" height="60" src="https://img.alicdn.com/imgextra/i6/tiny_60x60.jpg">
    <img width="400" height="400" src="https://img.alicdn.com/tps/i3/T1shoplogo.png">
    <img width="400" height="400" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <div id="bg" style="background-image:url('https://img.alicdn.com/imgextra/i7/bg.jpg')"></div>
  </div>
  <script>${INLINE_JSON}</script>
</body></html>`;

const LOGIN_FIXTURE = `<!DOCTYPE html>
<html><body><div class="login-box"><form id="login-form"></form></div></body></html>`;

const OTHER_FIXTURE = `<!DOCTYPE html>
<html><body><img width="800" height="800" src="https://example.com/a.jpg"></body></html>`;

let passed = 0;
let failed = 0;

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + (e && e.message));
  }
}

function quietConsole() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {}); // jsdom 未实现的 CSS/布局能力会产生告警，这里屏蔽
  vc.on('error', () => {});
  return vc;
}

/** 安装最小可用的 chrome API 桩 */
function installChromeStub(win, calls) {
  win.chrome = {
    runtime: {
      getURL: (p) => 'chrome-extension://emiemiemiemiemiemiemiemiemi/' + p,
      sendMessage: (msg) => {
        calls.push(msg);
        return Promise.resolve({ ok: true, count: (msg.payload && msg.payload.images && msg.payload.images.length) || 0 });
      },
      onMessage: { addListener: () => {} }
    }
  };
}

/** jsdom 不实现真实布局与完整层叠，这里为测试补上背景图与尺寸能力 */
function patchLayout(win, sizes) {
  const orig = win.getComputedStyle.bind(win);
  win.getComputedStyle = (el) => {
    const inline = el && el.style && el.style.backgroundImage;
    if (inline && inline !== 'none' && inline !== '') return { backgroundImage: inline };
    return orig(el);
  };
  win.Element.prototype.getBoundingClientRect = function () {
    const size = (sizes && sizes[this.id]) || { width: 0, height: 0 };
    return {
      width: size.width, height: size.height,
      top: 0, left: 0, right: size.width, bottom: size.height, x: 0, y: 0
    };
  };
}

function makeDom(html, url, sizes, calls) {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: quietConsole()
  });
  const win = dom.window;
  win.fetch = undefined; // 让 content.js 走 <link> 兜底分支（jsdom 无 fetch）
  installChromeStub(win, calls);
  patchLayout(win, sizes);
  win.eval(LIB_SRC);
  win.eval(CONTENT_SRC);
  return dom;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/* ======================= 主测试：详情页提取 ======================= */

async function testDetailPage() {
  console.log('\n[详情页] 按钮注入 + 图片提取');
  const calls = [];
  const dom = makeDom(FIXTURE, DETAIL_URL, { bg: { width: 600, height: 600 } }, calls);
  const win = dom.window;

  try {
    await tick(200); // 等 boot() 注入按钮

    const host = win.document.getElementById('emi-floating-root');
    ok('右侧悬浮按钮已注入', () => {
      assert.ok(host, '没有找到 #emi-floating-root');
      assert.ok(host.shadowRoot, '按钮没有使用 Shadow DOM');
      assert.strictEqual(host.shadowRoot.querySelector('.emi-fab__label').textContent, '获取图片');
      assert.ok(host.shadowRoot.querySelector('.emi-fab svg'), '按钮缺少图标');
    });

    ok('按钮样式通过 content.css 加载（jsdom 走 <link> 兜底）', () => {
      const link = host.shadowRoot.querySelector('link[rel="stylesheet"]');
      assert.ok(link, '没有注入 content.css');
      assert.ok(/content\.css$/.test(link.href), '样式地址不正确：' + (link && link.href));
    });

    ok('按钮定位为右下角悬浮且层级足够高', () => {
      assert.strictEqual(host.style.getPropertyValue('position'), 'fixed');
      assert.strictEqual(host.style.getPropertyValue('right'), '24px');
      assert.strictEqual(host.style.getPropertyValue('bottom'), '28px');
      assert.ok(Number(host.style.getPropertyValue('z-index')) >= 1000000, 'z-index 太低');
    });

    const api = win.EMI_DEBUG_API;
    ok('EMI_DEBUG_API 已挂载', () => {
      assert.ok(api && typeof api.collectImages === 'function');
      assert.strictEqual(api.platform, 'taobao');
      assert.strictEqual(api.isProductDetailPage(), true);
    });

    // 关闭自动滚动与联网探测，让测试可在离线环境完成
    api.config.AUTO_SCROLL = false;
    api.config.MAX_PROBE = 0;

    const images = await api.collectImages();
    const urls = images.map((x) => x.url);

    ok('采集到 10 张图片（含背景图与内联脚本里的图片）', () => {
      assert.strictEqual(images.length, 10, '实际得到：\n    ' + urls.join('\n    '));
    });

    ok('过滤 1x1 像素图 / 小于 100x100 / logo / data: 占位图', () => {
      urls.forEach((u) => {
        assert.ok(!/pixel\.gif/.test(u), '未过滤 1x1 像素图：' + u);
        assert.ok(!/tiny_60x60/.test(u), '未过滤小图：' + u);
        assert.ok(!/T1shoplogo|\/tps\//.test(u), '未过滤 logo：' + u);
        assert.ok(!/^data:/.test(u), '未过滤 data: 占位图：' + u);
      });
    });

    ok('同一张图的 430x430 与 800x800 变体已去重并升级为原图', () => {
      const mains = urls.filter((u) => /\/i1\/main/.test(u));
      assert.strictEqual(mains.length, 1, '去重失败：' + JSON.stringify(mains));
      assert.strictEqual(mains[0], 'https://img.alicdn.com/imgextra/i1/main.jpg');
    });

    ok('相对路径补全为绝对 URL', () => {
      assert.ok(urls.indexOf('https://detail.tmall.com/imgextra/i9/relative.png') !== -1,
        '相对路径未补全：\n    ' + urls.join('\n    '));
    });

    ok('srcset 取宽度最大的候选，data-* 懒加载属性被识别', () => {
      assert.ok(urls.indexOf('https://img.alicdn.com/imgextra/i3/big.jpg') !== -1, 'srcset 最大候选丢失');
      assert.ok(urls.indexOf('https://img.alicdn.com/imgextra/i4/attr.jpg') !== -1, 'data-* 懒加载属性未识别');
      assert.ok(urls.indexOf('//img.alicdn.com/imgextra/i2/lazy.png') === -1, 'data-src 未补全协议');
      assert.ok(urls.indexOf('https://img.alicdn.com/imgextra/i2/lazy.png') !== -1, 'data-src 未采集');
      assert.ok(urls.indexOf('https://img.alicdn.com/imgextra/i5/src.jpg') !== -1, 'picture/source 未采集');
    });

    ok('背景图被采集并带上元素尺寸', () => {
      const bg = images.find((x) => /\/i7\/bg\.jpg/.test(x.url));
      assert.ok(bg, '背景图未采集');
      assert.strictEqual(bg.width, 600);
      assert.strictEqual(bg.height, 600);
      assert.ok(bg.sources.indexOf('background') !== -1, '来源标记缺失');
    });

    ok('内联脚本中的图片地址被采集', () => {
      const inline = images.find((x) => /\/i8\/inline\.jpg/.test(x.url));
      assert.ok(inline, '内联脚本图片未采集');
      assert.ok(inline.sources.indexOf('inline-code') !== -1, '来源标记缺失');
    });

    ok('展示地址为原图地址之外的可加载地址（缩略图优先）', () => {
      const main = images.find((x) => /\/i1\/main\.jpg$/.test(x.url));
      assert.ok(main.thumb && main.thumb !== main.url, 'thumb 应保留页面原始（较小）地址，便于快速预览');
    });

    ok('结果按面积从大到小排序', () => {
      for (let i = 1; i < images.length; i++) {
        const prev = images[i - 1].width * images[i - 1].height;
        const cur = images[i].width * images[i].height;
        assert.ok(prev >= cur, '排序不正确：' + prev + ' < ' + cur);
      }
    });

    ok('每张图片都有唯一 id 与连续序号', () => {
      const ids = new Set(images.map((x) => x.id));
      assert.strictEqual(ids.size, images.length, 'id 有重复');
      images.forEach((x, i) => assert.strictEqual(x.index, i + 1));
    });

    // 点击按钮 -> 完整链路 -> 给扩展发消息
    await api.startScan();
    ok('点击按钮后通过 chrome.runtime.sendMessage 把结果发给扩展', () => {
      const sent = calls.find((m) => m.type === 'EMI_IMAGES_FOUND');
      assert.ok(sent, '没有发出 EMI_IMAGES_FOUND 消息');
      assert.strictEqual(sent.payload.images.length, 10);
      assert.strictEqual(sent.payload.platform, 'taobao');
      assert.ok(/detail\.tmall\.com/.test(sent.payload.pageUrl), 'pageUrl 不正确');
      assert.strictEqual(sent.payload.pageTitle, '测试商品详情页');
    });
  } finally {
    win.close();
  }
}

/* ======================= 反向测试：不注入按钮的页面 ======================= */

async function testNoInjection() {
  console.log('\n[非目标页面] 不应注入按钮');

  {
    const calls = [];
    const dom = makeDom(LOGIN_FIXTURE, LOGIN_URL, {}, calls);
    try {
      await tick(150);
      ok('登录页不注入按钮', () => {
        assert.strictEqual(dom.window.document.getElementById('emi-floating-root'), null);
        assert.strictEqual(dom.window.EMI_DEBUG_API.isProductDetailPage(), false);
      });
    } finally {
      dom.window.close();
    }
  }

  {
    const calls = [];
    const dom = makeDom(OTHER_FIXTURE, OTHER_URL, {}, calls);
    try {
      await tick(150);
      ok('非目标域名（example.com）不注入按钮', () => {
        assert.strictEqual(dom.window.document.getElementById('emi-floating-root'), null);
        assert.strictEqual(dom.window.EMI_DEBUG_API.platform, null);
        assert.strictEqual(dom.window.EMI_DEBUG_API.isProductDetailPage(), false);
      });
    } finally {
      dom.window.close();
    }
  }

  {
    const calls = [];
    // 京东 / 拼多多的详情页判定
    const jdHtml = '<!DOCTYPE html><html><body><div id="spec-img"></div>' +
      '<img width="800" height="800" src="https://img14.360buyimg.com/n1/s450x450_jfs/t1/1/2/3/4/a.jpg">' +
      '</body></html>';
    const dom = makeDom(jdHtml, 'https://item.jd.com/100012043978.html', {}, calls);
    try {
      await tick(150);
      ok('京东商品详情页会注入按钮', () => {
        assert.strictEqual(dom.window.EMI_DEBUG_API.platform, 'jd');
        assert.strictEqual(dom.window.EMI_DEBUG_API.isProductDetailPage(), true);
        assert.ok(dom.window.document.getElementById('emi-floating-root'));
      });
    } finally {
      dom.window.close();
    }
  }

  {
    const calls = [];
    const pddHtml = '<!DOCTYPE html><html><body><div class="goods-detail-pic"></div></body></html>';
    const dom = makeDom(pddHtml, 'https://mms.pinduoduo.com/goods/goods_detail?goods_id=1', {}, calls);
    try {
      await tick(150);
      ok('拼多多商家版商品页会注入按钮', () => {
        assert.strictEqual(dom.window.EMI_DEBUG_API.platform, 'pdd');
        assert.strictEqual(dom.window.EMI_DEBUG_API.isProductDetailPage(), true);
        assert.ok(dom.window.document.getElementById('emi-floating-root'));
      });
    } finally {
      dom.window.close();
    }
  }
}

(async () => {
  await testDetailPage();
  await testNoInjection();

  console.log('\n----------------------------------------');
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
