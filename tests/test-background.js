/**
 * tests/test-background.js
 * ---------------------------------------------------------------------------
 * 用 Node + vm 模拟 Service Worker 环境（chrome.downloads / tabs / storage、
 * fetch、createImageBitmap、OffscreenCanvas），加载真实的 background.js，
 * 验证消息路由、PNG 转换、文件名规则、大文件 blob 通道与失败降级。
 * 运行： node tests/test-background.js
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'lib', 'image-utils.js');
const BG_SRC = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

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

/* ======================= 模拟浏览器环境 ======================= */

const env = {
  storage: {},
  tabs: [],
  downloads: [],
  broadcasts: [],
  fetchCalls: [],
  failFetch: [],          // 命中则 fetch 抛错（模拟缺少 host 权限）
  pngSize: 200 * 1024,    // 转换出来的 PNG 体积
  nextTabId: 100
};

const messageListeners = [];
const downloadListeners = [];

global.self = global;
global.importScripts = (...files) => {
  files.forEach((f) => {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f.replace(/^\.\//, '')), 'utf8'), { filename: f });
  });
};

global.chrome = {
  runtime: {
    lastError: undefined,
    getURL: (p) => 'chrome-extension://emiemiemiemiemiemiemiemiemi/' + p,
    getPlatformInfo: (cb) => cb && cb({ os: 'win' }),
    sendMessage: (msg) => {
      env.broadcasts.push(msg);
      return Promise.resolve();
    },
    onMessage: { addListener: (fn) => messageListeners.push(fn) }
  },
  storage: {
    local: {
      get: (keys, cb) => {
        const out = {};
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach((k) => { if (k in env.storage) out[k] = env.storage[k]; });
        cb(out);
      },
      set: (obj, cb) => {
        Object.assign(env.storage, obj);
        if (cb) cb();
      }
    }
  },
  tabs: {
    create: async ({ url }) => {
      const tab = { id: env.nextTabId++, url };
      env.tabs.push(tab);
      return tab;
    },
    update: async () => ({}),
    get: (id, cb) => {
      const tab = env.tabs.find((t) => t.id === id);
      // 模拟 lastError 语义：找不到时 undefined
      global.chrome.runtime.lastError = tab ? undefined : undefined;
      cb(tab);
    },
    sendMessage: (tabId, msg, cb) => {
      if (msg.type === 'EMI_SAVE_VIA_BLOB') {
        if (cb) queueMicrotask(() => cb({ accepted: true }));
        // 模拟预览页完成 blob 保存后回执
        setTimeout(() => {
          void dispatch({ type: 'EMI_BLOB_SAVE_RESULT', payload: { reqId: msg.payload.reqId, ok: true } });
        }, 5);
      } else if (cb) {
        queueMicrotask(() => cb({ ok: true }));
      }
    },
    onRemoved: { addListener: () => {} }
  },
  downloads: {
    download: (options, cb) => {
      const id = env.downloads.length + 1;
      const record = {
        id, url: options.url, filename: options.filename,
        conflictAction: options.conflictAction, state: 'in_progress'
      };
      env.downloads.push(record);
      if (cb) queueMicrotask(() => cb(id));
      // 模拟下载很快完成
      setTimeout(() => {
        record.state = 'complete';
        downloadListeners.forEach((fn) => fn({ id, state: { current: 'complete' } }));
      }, 5);
      return Promise.resolve(id);
    },
    search: ({ id }, cb) => {
      cb(env.downloads.filter((d) => d.id === id));
    },
    onChanged: {
      addListener: (fn) => downloadListeners.push(fn),
      removeListener: (fn) => {
        const i = downloadListeners.indexOf(fn);
        if (i !== -1) downloadListeners.splice(i, 1);
      }
    }
  },
  action: { onClicked: { addListener: () => {} } },
  scripting: { executeScript: async () => [] }
};

global.fetch = async (url) => {
  env.fetchCalls.push(url);
  if (env.failFetch.some((f) => url.indexOf(f) !== -1)) {
    throw new TypeError('Failed to fetch');
  }
  const bytes = Buffer.alloc(64 * 1024, 7);
  return {
    ok: true,
    status: 200,
    async blob() {
      // 模拟 CDN 返回 octet-stream，检验 MIME 纠正逻辑
      return new Blob([bytes], { type: 'application/octet-stream' });
    }
  };
};

global.createImageBitmap = async (blob) => ({ width: 1200, height: 1200, close() {} });

global.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { drawImage() {} }; }
  async convertToBlob({ type }) {
    return new Blob([Buffer.alloc(env.pngSize, 9)], { type: type || 'image/png' });
  }
};

/** 派发 runtime 消息（支持异步 sendResponse） */
function dispatch(msg, sender) {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (resp) => { settled = true; resolve(resp); };
    let async = false;
    messageListeners.forEach((fn) => {
      const r = fn(msg, sender || { tab: { id: 7, url: 'https://item.taobao.com/item.htm?id=1' } }, sendResponse);
      if (r === true) async = true;
    });
    if (!async && !settled) resolve(undefined);
  });
}

function waitFor(predicate, timeoutMs, what) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let value;
      try { value = predicate(); } catch (e) { value = null; }
      if (value) { resolve(value); return; }
      if (Date.now() - start > (timeoutMs || 5000)) {
        reject(new Error('等待超时：' + (what || '条件未满足')));
        return;
      }
      setTimeout(poll, 20);
    })();
  });
}

/* ======================= 加载被测代码 ======================= */

vm.runInThisContext(BG_SRC, { filename: 'background.js' });

/* ======================= 测试用例 ======================= */

async function run() {
  console.log('\n[消息注册]');
  ok('注册了 runtime 消息监听器', () => {
    assert.strictEqual(messageListeners.length, 2, '应有 2 个监听器（路由 + blob 回执）');
  });

  console.log('\n[EMI_IMAGES_FOUND] 提取结果落库并打开预览页');
  const images = [
    { id: 'a1', url: 'https://img.alicdn.com/imgextra/i1/a.jpg', thumb: 'https://img.alicdn.com/imgextra/i1/a.jpg_430x430q90.jpg', width: 1200, height: 1200 },
    { id: 'a2', url: 'https://img.alicdn.com/imgextra/i2/b.jpg', thumb: 'https://img.alicdn.com/imgextra/i2/b.jpg', width: 800, height: 800 },
    { id: 'a3', url: 'https://img14.360buyimg.com/n0/jfs/t1/1/2/3/4/c.jpg', thumb: 'https://img14.360buyimg.com/n1/s450x450_jfs/t1/1/2/3/4/c.jpg', width: 900, height: 900 }
  ];

  const foundResp = await dispatch({
    type: 'EMI_IMAGES_FOUND',
    payload: {
      images,
      pageUrl: 'https://detail.tmall.com/item.htm?id=1',
      pageTitle: '测试宝贝',
      platform: 'taobao'
    }
  });

  ok('返回成功与图片数量', () => {
    assert.ok(foundResp && foundResp.ok, '响应异常：' + JSON.stringify(foundResp));
    assert.strictEqual(foundResp.count, 3);
  });
  ok('会话写入 chrome.storage.local', () => {
    const session = env.storage.emi_session;
    assert.ok(session, '没有写入会话');
    assert.strictEqual(session.images.length, 3);
    assert.strictEqual(session.platform, 'taobao');
    assert.strictEqual(session.tabId, 7, '应记录来源标签页 id（用于重新获取）');
  });
  ok('打开了预览页 gallery.html', () => {
    assert.strictEqual(env.tabs.length, 1);
    assert.ok(/gallery\.html$/.test(env.tabs[0].url), '标签页地址不正确：' + env.tabs[0].url);
  });

  console.log('\n[EMI_GET_SESSION] 预览页读取数据');
  const sessionResp = await dispatch({ type: 'EMI_GET_SESSION' });
  ok('返回会话与进度快照', () => {
    assert.ok(sessionResp.ok);
    assert.strictEqual(sessionResp.session.images.length, 3);
    assert.ok(sessionResp.progress === null || typeof sessionResp.progress === 'object');
  });

  console.log('\n[EMI_DOWNLOAD] 小文件：转 PNG 后走 data: URL');
  env.downloads.length = 0;
  env.broadcasts.length = 0;
  env.pngSize = 200 * 1024;

  const startResp = await dispatch({
    type: 'EMI_DOWNLOAD',
    payload: {
      items: [
        { id: 'a1', url: images[0].url, altUrls: [images[0].thumb], index: 1 },
        { id: 'a2', url: images[1].url, altUrls: [], index: 2 }
      ],
      prefix: '商品图',
      pad: 3
    }
  });

  ok('立即返回，进入后台下载', () => {
    assert.ok(startResp && startResp.ok, JSON.stringify(startResp));
    assert.strictEqual(startResp.total, 2);
  });

  const finished = await waitFor(
    () => env.broadcasts.find((m) => m.type === 'EMI_FINISHED'),
    8000,
    'EMI_FINISHED 广播'
  );

  ok('下载了 2 张图片，文件名按 商品图_序号.png 规则补零', () => {
    const names = env.downloads.map((d) => d.filename).sort();
    assert.deepStrictEqual(names, ['商品图_001.png', '商品图_002.png']);
    env.downloads.forEach((d) => {
      assert.ok(/^data:image\/png;base64,/.test(d.url), '没有走 PNG data URL：' + d.url.slice(0, 40));
    });
  });

  ok('转换时使用了正确的原图地址（跳过缩略图）', () => {
    assert.ok(env.fetchCalls.indexOf(images[0].url) !== -1, '没有请求原图地址');
    assert.ok(env.fetchCalls.indexOf(images[0].thumb) === -1, '不应优先请求缩略图');
  });

  ok('广播了进度事件', () => {
    assert.ok(env.broadcasts.some((m) => m.type === 'EMI_PROGRESS'), '缺少 EMI_PROGRESS');
  });

  ok('完成事件汇总成功 / 失败数量', () => {
    assert.strictEqual(finished.payload.ok, 2, JSON.stringify(finished.payload));
    assert.strictEqual(finished.payload.failed, 0);
    assert.strictEqual(finished.payload.state, 'done');
  });

  ok('进度快照写入存储，预览页重新打开也能恢复', () => {
    const progress = env.storage.emi_progress;
    assert.strictEqual(progress.running, false);
    assert.strictEqual(progress.total, 2);
    assert.strictEqual(progress.results.length, 2);
  });

  console.log('\n[大文件] PNG 超过 data: URL 上限时改走预览页 blob 通道');
  env.downloads.length = 0;
  env.broadcasts.length = 0;
  env.pngSize = 3 * 1024 * 1024; // 3MB PNG -> base64 超过 data URL 上限

  await dispatch({
    type: 'EMI_DOWNLOAD',
    payload: { items: [{ id: 'a3', url: images[2].url, index: 3 }], prefix: '商品图', pad: 3 }
  });

  const finished2 = await waitFor(
    () => env.broadcasts.find((m) => m.type === 'EMI_FINISHED'),
    8000,
    '大文件下载完成'
  );

  ok('大文件不再使用 data: URL，而是交给预览页用 blob URL 保存', () => {
    assert.strictEqual(env.downloads.length, 0, '不应由 Service Worker 直接下载 data URL');
    assert.strictEqual(finished2.payload.ok, 1, JSON.stringify(finished2.payload));
    assert.strictEqual(finished2.payload.results[0].filename, '商品图_003.png');
    assert.strictEqual(finished2.payload.results[0].mode, 'png');
  });

  console.log('\n[失败降级] 缺少 host 权限导致 fetch 失败时按原格式直链下载');
  env.downloads.length = 0;
  env.broadcasts.length = 0;
  env.pngSize = 200 * 1024;
  env.fetchCalls.length = 0;
  env.failFetch.push('cdn-not-allowed.example.com');

  const fallbackUrl = 'https://cdn-not-allowed.example.com/photo/xyz.jpg';
  await dispatch({
    type: 'EMI_DOWNLOAD',
    payload: { items: [{ id: 'b1', url: fallbackUrl, index: 4 }], prefix: '商品图', pad: 3 }
  });

  const finished3 = await waitFor(
    () => env.broadcasts.find((m) => m.type === 'EMI_FINISHED'),
    8000,
    '降级下载完成'
  );

  ok('降级为直链下载，扩展名保持原格式', () => {
    assert.strictEqual(finished3.payload.ok, 1, JSON.stringify(finished3.payload));
    assert.strictEqual(finished3.payload.results[0].mode, 'original');
    assert.strictEqual(finished3.payload.results[0].filename, '商品图_004.jpg');
    assert.strictEqual(env.downloads.length, 1);
    assert.strictEqual(env.downloads[0].url, fallbackUrl);
    assert.ok(/原格式/.test(finished3.payload.results[0].note || ''), '应提示按原格式下载');
  });
  env.failFetch.length = 0;

  console.log('\n[EMI_RESCAN / EMI_OPEN_SOURCE / EMI_CLEAR_SESSION]');

  // 补一个「原详情页」标签页，模拟真实场景（id 与 EMI_IMAGES_FOUND 时的 sender.tab.id 一致）
  env.tabs.push({ id: 7, url: 'https://detail.tmall.com/item.htm?id=1' });

  const rescanResp = await dispatch({ type: 'EMI_RESCAN' });
  ok('重新获取会通知原详情页并返回成功', () => {
    assert.ok(rescanResp && rescanResp.ok, JSON.stringify(rescanResp));
  });

  // 原详情页已关闭时应给出可读的错误提示
  env.tabs.length = 0;
  const rescanFail = await dispatch({ type: 'EMI_RESCAN' });
  ok('原详情页关闭时返回明确错误', () => {
    assert.strictEqual(rescanFail.ok, false);
    assert.ok(/已关闭/.test(rescanFail.error), rescanFail.error);
  });

  const openResp = await dispatch({ type: 'EMI_OPEN_SOURCE' });
  ok('可以打开来源页面', () => assert.ok(openResp.ok, JSON.stringify(openResp)));

  await dispatch({ type: 'EMI_CLEAR_SESSION' });
  ok('清除会话后存储被重置', () => {
    assert.strictEqual(env.storage.emi_session, null);
  });

  console.log('\n----------------------------------------');
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
