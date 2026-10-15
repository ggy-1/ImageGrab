/**
 * background.js —— Service Worker（MV3）
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 接收 content script 提取到的图片列表，写入 chrome.storage.local 并打开预览页；
 *   2. 处理预览页的批量下载请求：fetch -> createImageBitmap -> OffscreenCanvas
 *      统一转成 PNG（无损），再用 chrome.downloads.download 保存；
 *   3. 把下载进度实时广播给预览页，并保存进度快照（预览页关闭再打开也能恢复）。
 *
 * 关于跨域：Service Worker 中 fetch 会带上扩展的 host_permissions，因此对
 *   已在 manifest 中声明的图片 CDN（alicdn / 360buyimg / pddpic 等）不受页面 CORS 限制。
 *   若某个图片域名未声明，转换会失败，此时自动降级为「原始格式直链下载」。
 *
 * 关于大文件：chrome.downloads.download 走 data: URL 时有长度限制（约 2MB 字符），
 *   超出时自动改走「预览页 blob URL 通道」（EMI_SAVE_VIA_BLOB），blob URL 没有长度限制。
 * ---------------------------------------------------------------------------
 */

importScripts('lib/image-utils.js');

const U = self.EMIUtils;

/* ======================= 常量 ======================= */

const SESSION_KEY = 'emi_session';        // 最近一次提取结果
const PROGRESS_KEY = 'emi_progress';      // 下载进度快照

const MAX_DATA_URL_CHARS = 1500000;       // data: URL 的最大字符数（预留安全余量）
const BLOB_SAVE_TIMEOUT = 120000;         // 走 blob 通道保存的超时（毫秒）
const DOWNLOAD_TIMEOUT = 120000;          // 单个下载任务超时（毫秒）
const BATCH_CONCURRENCY = 3;              // 同时处理的图片数量
const KEEP_ALIVE_MS = 20000;              // 批量下载期间的心跳，避免 SW 被回收
const GALLERY_PAGE = 'gallery.html';

/* ======================= 运行时状态 ======================= */

let galleryTabId = null;                  // 预览页所在标签页
let batchState = createEmptyState();      // 当前下载任务状态
let cancelRequested = false;
let keepAliveTimer = null;
const pendingBlobSaves = new Map();       // reqId -> {resolve, timer}

function createEmptyState() {
  return {
    running: false,
    state: 'idle',      // idle | running | done | cancelled | error
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    prefix: '商品图',
    results: [],
    startedAt: 0,
    finishedAt: 0
  };
}

/* ======================= 通用小工具 ======================= */

/** 广播消息给所有扩展页面（预览页据此刷新进度）；没有接收方时静默失败 */
function broadcast(message) {
  try {
    const p = chrome.runtime.sendMessage(message);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* 忽略没有接收方的报错 */ }
}

/** Promise 版 chrome.storage.local.get */
function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data || {}));
  });
}

/** Promise 版 chrome.storage.local.set */
function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

/** Promise 版 chrome.tabs.get，标签页不存在时返回 null */
function getTab(tabId) {
  return new Promise((resolve) => {
    if (tabId == null) { resolve(null); return; }
    try {
      chrome.tabs.get(tabId, (tab) => {
        resolve(chrome.runtime.lastError ? null : tab || null);
      });
    } catch (e) { resolve(null); }
  });
}

/** Promise 版 chrome.tabs.sendMessage */
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    if (tabId == null) { resolve({ ok: false, error: '标签页不存在' }); return; }
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp || { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

/* ======================= 标签页管理 ======================= */

/** 打开（或复用）预览页 */
async function openGalleryTab() {
  const url = chrome.runtime.getURL(GALLERY_PAGE);
  const existing = await getTab(galleryTabId);
  if (existing) {
    try {
      // 复用已有预览页（页面会通过 EMI_SESSION_UPDATED 自行刷新，无需重新加载）
      await chrome.tabs.update(galleryTabId, { active: true });
    } catch (e) { /* 忽略 */ }
    return galleryTabId;
  }
  const tab = await chrome.tabs.create({ url, active: true });
  galleryTabId = tab.id;
  return galleryTabId;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === galleryTabId) galleryTabId = null;
});

// 点击工具栏图标：直接打开预览页（没有数据时预览页会显示操作指引）
chrome.action.onClicked.addListener(() => {
  openGalleryTab();
});

/* ======================= 消息路由 ======================= */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;

  switch (msg.type) {
    /* --- 来自 content script：提取完成 --- */
    case 'EMI_IMAGES_FOUND':
      handleImagesFound(msg.payload, sender)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    /* --- 来自预览页 --- */
    case 'EMI_GET_SESSION':
      Promise.all([storageGet([SESSION_KEY]), storageGet([PROGRESS_KEY])]).then(([s, p]) => {
        sendResponse({ ok: true, session: s[SESSION_KEY] || null, progress: p[PROGRESS_KEY] || null });
      });
      return true;

    case 'EMI_CLEAR_SESSION':
      batchState = createEmptyState();
      storageSet({ [SESSION_KEY]: null, [PROGRESS_KEY]: null }).then(() => sendResponse({ ok: true }));
      return true;

    case 'EMI_RESCAN':
      rescanSourceTab().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    case 'EMI_OPEN_SOURCE':
      openSourceTab().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    case 'EMI_DOWNLOAD':
      startBatch(msg.payload)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    case 'EMI_CANCEL_DOWNLOAD':
      cancelRequested = true;
      broadcast({ type: 'EMI_ITEM_STATE', payload: { state: 'cancelling' } });
      sendResponse({ ok: true });
      return false;

    default:
      return undefined;
  }
});

/* ======================= 提取结果处理 ======================= */

async function handleImagesFound(payload, sender) {
  const images = (payload && Array.isArray(payload.images)) ? payload.images : [];
  if (!images.length) return { ok: false, error: '图片列表为空' };

  const session = {
    images,
    pageUrl: (payload && payload.pageUrl) || (sender && sender.tab && sender.tab.url) || '',
    pageTitle: (payload && payload.pageTitle) || '',
    platform: (payload && payload.platform) || '',
    tabId: sender && sender.tab ? sender.tab.id : null,
    createdAt: Date.now()
  };

  await storageSet({ [SESSION_KEY]: session, [PROGRESS_KEY]: createEmptyState() });
  const tabId = await openGalleryTab();
  // 已经打开的预览页需要立刻刷新
  await sendToTab(tabId, { type: 'EMI_SESSION_UPDATED' });
  return { ok: true, count: images.length, galleryTabId: tabId };
}

/** 让来源详情页重新扫描一次 */
async function rescanSourceTab() {
  const data = await storageGet([SESSION_KEY]);
  const session = data[SESSION_KEY];
  const tabId = session && session.tabId;
  const tab = await getTab(tabId);
  if (!tab) return { ok: false, error: '原详情页已关闭，请重新打开商品页后点击「获取图片」' };

  let resp = await sendToTab(tabId, { type: 'EMI_RESCAN' });
  if (resp && resp.ok) return resp;

  // content script 可能因为扩展更新而失效，这里用 scripting 权限重新注入一次
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/image-utils.js', 'content.js']
    });
    resp = await sendToTab(tabId, { type: 'EMI_RESCAN' });
    if (resp && resp.ok) return resp;
  } catch (e) {
    return { ok: false, error: '重新注入脚本失败：' + String(e && e.message || e) };
  }
  return resp || { ok: false, error: '原页面脚本无响应，请刷新页面后重试' };
}

async function openSourceTab() {
  const data = await storageGet([SESSION_KEY]);
  const session = data[SESSION_KEY];
  if (!session || !session.pageUrl) return { ok: false, error: '没有记录来源页面' };
  await chrome.tabs.create({ url: session.pageUrl, active: true });
  return { ok: true };
}

/* ======================= 批量下载 ======================= */

async function startBatch(payload) {
  if (batchState.running) return { ok: false, error: '已有下载任务正在进行，请等待完成或先取消' };

  const items = ((payload && payload.items) || []).filter((x) => x && x.url);
  if (!items.length) return { ok: false, error: '没有选中任何图片' };

  cancelRequested = false;
  batchState = createEmptyState();
  batchState.running = true;
  batchState.state = 'running';
  batchState.total = items.length;
  batchState.prefix = U.sanitizePrefix(payload.prefix);
  batchState.startedAt = Date.now();
  batchState.results = [];
  await storageSet({ [PROGRESS_KEY]: batchState });

  const options = {
    prefix: batchState.prefix,
    pad: payload.pad || 3,
    galleryTabId: payload.galleryTabId || galleryTabId
  };

  // 后台执行，立即返回，进度通过 broadcast 推送
  runBatch(items, options);

  return { ok: true, total: items.length };
}

async function runBatch(items, options) {
  startKeepAlive();
  broadcast({
    type: 'EMI_PROGRESS',
    payload: { state: 'running', total: items.length, done: 0, ok: 0, failed: 0 }
  });

  let cursor = 0;
  const results = new Array(items.length).fill(null);

  const worker = async () => {
    for (;;) {
      if (cancelRequested) return;
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];

      broadcast({ type: 'EMI_ITEM_STATE', payload: { id: item.id, status: 'converting' } });

      let result;
      try {
        // item.index 允许预览页指定序号（例如单张下载时保持与原卡片一致）
        result = await processItem(item, item.index || (i + 1), options);
      } catch (e) {
        result = { ok: false, error: String(e && e.message || e) };
      }

      const record = {
        id: item.id,
        index: i + 1,
        ok: !!result.ok,
        filename: result.filename || '',
        bytes: result.bytes || 0,
        mode: result.mode || '',
        note: result.note || '',
        error: result.ok ? '' : (result.error || '未知错误')
      };
      results[i] = record;

      batchState.done++;
      if (record.ok) batchState.ok++; else batchState.failed++;
      batchState.results = results.filter(Boolean);
      await storageSet({ [PROGRESS_KEY]: batchState });

      broadcast({
        type: 'EMI_PROGRESS',
        payload: {
          state: 'running',
          total: items.length,
          done: batchState.done,
          ok: batchState.ok,
          failed: batchState.failed,
          last: record
        }
      });
    }
  };

  try {
    const workers = [];
    for (let k = 0; k < Math.min(BATCH_CONCURRENCY, items.length); k++) workers.push(worker());
    await Promise.all(workers);

    batchState.running = false;
    batchState.state = cancelRequested ? 'cancelled' : 'done';
    batchState.finishedAt = Date.now();
    batchState.results = results.filter(Boolean);
    await storageSet({ [PROGRESS_KEY]: batchState });

    broadcast({
      type: 'EMI_FINISHED',
      payload: {
        state: batchState.state,
        total: batchState.total,
        done: batchState.done,
        ok: batchState.ok,
        failed: batchState.failed,
        results: batchState.results
      }
    });
  } finally {
    stopKeepAlive();
  }
}

/**
 * 处理单张图片：优先「转 PNG 后保存」，全部地址都失败时降级为原格式直链下载。
 * items 里 url 是原图地址，altUrls 是备选地址（例如页面上的缩略图地址）。
 */
async function processItem(item, index, options) {
  const candidates = [];
  [item.url].concat(item.altUrls || []).forEach((u) => {
    if (U.isHttpUrl(u) && candidates.indexOf(u) === -1) candidates.push(u);
  });

  let lastError = '没有可用的图片地址';

  // ---- 方案 A：转 PNG ----
  for (const url of candidates) {
    const filename = U.buildFilename(options.prefix, index, options.pad, 'png');
    try {
      const pngBlob = await toPngBlob(url);
      await savePngBlob(pngBlob, filename, options.galleryTabId);
      return { ok: true, filename, bytes: pngBlob.size, mode: 'png' };
    } catch (e) {
      lastError = String(e && e.message || e);
    }
  }

  // ---- 方案 B：兜底直链下载（保持原格式，扩展名按实际类型给出）----
  for (const url of candidates) {
    try {
      const format = U.guessFormat(url);
      const ext = format === '未知' ? 'jpg' : format.toLowerCase();
      const filename = U.buildFilename(options.prefix, index, options.pad, ext);
      const downloadId = await startDownload({ url, filename });
      await waitDownload(downloadId);
      return {
        ok: true,
        filename,
        mode: 'original',
        note: '该图片域名未授权转换，已按原格式下载'
      };
    } catch (e) {
      lastError = String(e && e.message || e);
    }
  }

  return { ok: false, error: lastError };
}

/* ======================= PNG 转换 ======================= */

/**
 * 下载图片并统一转换为 PNG。
 * fetch 在 Service Worker 中执行，凭 manifest 的 host_permissions 绕过页面 CORS 限制。
 * @param {string} url 图片地址
 * @returns {Promise<Blob>} PNG Blob
 */
async function toPngBlob(url) {
  let res;
  try {
    res = await fetch(url, { credentials: 'omit', mode: 'cors', redirect: 'follow' });
  } catch (e) {
    throw new Error('请求图片失败（可能缺少该域名的 host 权限）：' + String(e && e.message || e));
  }
  if (!res.ok) throw new Error('图片请求返回 HTTP ' + res.status);

  let blob = await res.blob();
  if (!blob || blob.size === 0) throw new Error('图片内容为空');

  // 不少 CDN 返回 application/octet-stream，按扩展名纠正 MIME，否则解码会失败
  const guessed = U.guessMimeFromUrl(url);
  if (guessed && blob.type !== guessed && !/^image\//i.test(blob.type)) {
    blob = new Blob([await blob.arrayBuffer()], { type: guessed });
  }
  if (/^image\/svg/i.test(blob.type)) throw new Error('SVG 矢量图不作为商品图转换');
  if (/^image\/png$/i.test(blob.type)) return blob; // 本来就是 PNG，无损直接使用

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    throw new Error('图片解码失败：' + String(e && e.message || e));
  }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('图片尺寸为 0');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    // 注意：GIF / 动态 WebP 只会保留第一帧
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

/** Blob -> base64（Service Worker 里没有 FileReader，用 btoa 分块拼接） */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 保存 PNG：
 *   小文件 -> data: URL 直接交给 chrome.downloads.download；
 *   大文件或 data URL 失败 -> 交给预览页用 blob URL 保存（blob URL 无长度限制）。
 */
async function savePngBlob(pngBlob, filename, tabId) {
  const base64 = await blobToBase64(pngBlob);
  const dataUrl = 'data:image/png;base64,' + base64;

  if (dataUrl.length <= MAX_DATA_URL_CHARS) {
    try {
      const downloadId = await startDownload({ url: dataUrl, filename });
      await waitDownload(downloadId);
      return;
    } catch (e) {
      // 落到下面的 blob 通道
    }
  }

  const ok = await saveViaGallery(base64, filename, tabId);
  if (!ok) throw new Error('图片过大且预览页未响应，无法保存 PNG');
}

/** 请求预览页用 URL.createObjectURL + chrome.downloads 保存（大文件通道） */
function saveViaGallery(base64, filename, tabId) {
  return new Promise((resolve) => {
    const reqId = 'blob_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const timer = setTimeout(() => {
      pendingBlobSaves.delete(reqId);
      resolve(false);
    }, BLOB_SAVE_TIMEOUT);

    pendingBlobSaves.set(reqId, {
      resolve: (ok) => {
        clearTimeout(timer);
        pendingBlobSaves.delete(reqId);
        resolve(ok);
      }
    });

    if (tabId == null) {
      clearTimeout(timer);
      pendingBlobSaves.delete(reqId);
      resolve(false);
      return;
    }
    // 预览页收到后先回 accepted，处理好下载再用 EMI_BLOB_SAVE_RESULT 回结果
    sendToTab(tabId, { type: 'EMI_SAVE_VIA_BLOB', payload: { reqId, base64, filename } })
      .then((resp) => {
        if (!resp || !resp.accepted) {
          const pending = pendingBlobSaves.get(reqId);
          if (pending) pending.resolve(false);
        }
      });
  });
}

/* ======================= 下载封装 ======================= */

/** Promise 版 chrome.downloads.download */
function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: options.url,
        filename: options.filename,
        conflictAction: 'uniquify', // 同名时自动追加 (1)(2)，不覆盖用户已有文件
        saveAs: false
      },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err || downloadId == null) {
          reject(new Error(err ? err.message : '创建下载任务失败'));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

/** 等待某个下载任务结束（完成或中断） */
function waitDownload(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
    }
    function finish(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    }
    function onChanged(delta) {
      if (!delta || delta.id !== downloadId) return;
      if (delta.state && delta.state.current === 'complete') finish(null);
      else if (delta.state && delta.state.current === 'interrupted') {
        finish(new Error('下载被中断：' + ((delta.error && delta.error.current) || 'unknown')));
      }
    }

    timer = setTimeout(() => finish(new Error('下载超时')), DOWNLOAD_TIMEOUT);
    chrome.downloads.onChanged.addListener(onChanged);
    // 补齐「监听器注册前就已经完成」的竞态
    chrome.downloads.search({ id: downloadId }, (items) => {
      const it = items && items[0];
      if (!it) return;
      if (it.state === 'complete') finish(null);
      else if (it.state === 'interrupted') finish(new Error('下载被中断'));
    });
  });
}

/* ======================= 心跳：防止批量下载期间 SW 被回收 ======================= */

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // 任意一次 Chrome API 调用都能刷新 SW 的空闲计时器
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch (e) { /* 忽略 */ }
  }, KEEP_ALIVE_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/* ======================= 统一处理预览页发来的回调消息 ======================= */

// 预览页在 blob 通道保存完成后回消息（这里单独注册一个监听器，避免与上面的路由纠缠）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'EMI_BLOB_SAVE_RESULT') {
    const pending = pendingBlobSaves.get(msg.payload && msg.payload.reqId);
    if (pending) pending.resolve(!!(msg.payload && msg.payload.ok));
    sendResponse({ ok: true });
    return false;
  }
  return undefined;
});
