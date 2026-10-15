/**
 * gallery.js —— 预览页逻辑
 * ---------------------------------------------------------------------------
 * 1. 从 Service Worker 读取最近一次提取结果并网格化展示；
 * 2. 提供全选 / 反选 / 清空 / 按最小尺寸筛选 / Shift 连选；
 * 3. 勾选后批量下载，下载进度与结果实时回显；
 * 4. 大图保存通道：Service Worker 转好 PNG 后若 data: URL 过长，
 *    会请本页用 URL.createObjectURL + chrome.downloads 保存（blob URL 无长度限制）。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ======================= 页面元素 ======================= */

  const el = {
    tagline: document.getElementById('tagline'),
    platformChip: document.getElementById('platformChip'),
    timeChip: document.getElementById('timeChip'),
    sourceLink: document.getElementById('sourceLink'),
    grid: document.getElementById('grid'),
    empty: document.getElementById('empty'),
    progress: document.getElementById('progress'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
    progressStat: document.getElementById('progressStat'),
    selectedCount: document.getElementById('selectedCount'),
    totalCount: document.getElementById('totalCount'),
    prefixInput: document.getElementById('prefixInput'),
    minSizeSelect: document.getElementById('minSizeSelect'),
    btnAll: document.getElementById('btnAll'),
    btnInvert: document.getElementById('btnInvert'),
    btnNone: document.getElementById('btnNone'),
    btnDownload: document.getElementById('btnDownload'),
    btnCancel: document.getElementById('btnCancel'),
    btnRescan: document.getElementById('btnRescan'),
    btnClear: document.getElementById('btnClear'),
    report: document.getElementById('report'),
    reportTitle: document.getElementById('reportTitle'),
    reportStats: document.getElementById('reportStats'),
    reportList: document.getElementById('reportList'),
    btnCopyFailed: document.getElementById('btnCopyFailed'),
    footerRule: document.getElementById('footerRule'),
    toast: document.getElementById('toast')
  };

  /* ======================= 状态 ======================= */

  const state = {
    session: null,
    images: [],
    selected: new Set(),
    anchorId: null,
    downloading: false,
    failedList: [],
    prefs: { prefix: '商品图', minSize: 0 },
    cards: new Map() // id -> { card, checkbox, status }
  };

  const PLATFORM_LABEL = {
    taobao: '淘宝 / 天猫',
    jd: '京东',
    pdd: '拼多多 / 商家版'
  };

  /* ======================= 小工具 ======================= */

  function toast(text, kind) {
    el.toast.textContent = text;
    el.toast.dataset.kind = kind || 'info';
    el.toast.hidden = false;
    // 触发过渡
    requestAnimationFrame(() => el.toast.classList.add('is-visible'));
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      el.toast.classList.remove('is-visible');
      setTimeout(() => { el.toast.hidden = true; }, 260);
    }, kind === 'error' ? 6000 : 3200);
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** 等待某个下载任务结束（用于 blob 通道确认保存结果） */
  function waitDownloadDone(downloadId, timeoutMs) {
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
      timer = setTimeout(() => finish(new Error('下载超时')), timeoutMs || 120000);
      chrome.downloads.onChanged.addListener(onChanged);
      chrome.downloads.search({ id: downloadId }, (items) => {
        const it = items && items[0];
        if (!it) return;
        if (it.state === 'complete') finish(null);
        else if (it.state === 'interrupted') finish(new Error('下载被中断'));
      });
    });
  }

  /* ======================= 初始化 ======================= */

  async function init() {
    await loadPrefs();
    bindEvents();
    await refreshSession();
  }

  async function loadPrefs() {
    try {
      const data = await chrome.storage.local.get('emi_prefs');
      const prefs = data && data.emi_prefs;
      if (prefs) {
        state.prefs.prefix = prefs.prefix || '商品图';
        state.prefs.minSize = Number(prefs.minSize) || 0;
      }
    } catch (e) { /* 忽略 */ }
    el.prefixInput.value = state.prefs.prefix;
    el.minSizeSelect.value = String(state.prefs.minSize);
    updateFooterRule();
  }

  function savePrefs() {
    state.prefs.prefix = el.prefixInput.value.trim() || '商品图';
    state.prefs.minSize = Number(el.minSizeSelect.value) || 0;
    chrome.storage.local.set({ emi_prefs: state.prefs });
  }

  function updateFooterRule() {
    const prefix = el.prefixInput.value.trim() || '商品图';
    el.footerRule.textContent = prefix + '_001.png';
  }

  /** 读取提取结果与进度 */
  async function refreshSession() {
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'EMI_GET_SESSION' });
    } catch (e) {
      toast('无法连接扩展后台，请重新打开本页', 'error');
      return;
    }
    applySession(resp && resp.session);
    applyProgressSnapshot(resp && resp.progress);
  }

  function applySession(session) {
    state.session = session || null;
    state.images = (session && Array.isArray(session.images)) ? session.images : [];

    // 保留仍然存在的选中项
    const validIds = new Set(state.images.map((r) => r.id));
    const nextSelected = new Set();
    state.selected.forEach((id) => { if (validIds.has(id)) nextSelected.add(id); });
    state.selected = nextSelected;

    // 页眉信息
    if (state.images.length) {
      const platform = PLATFORM_LABEL[session.platform] || '商品详情页';
      el.tagline.textContent = platform + ' · 共 ' + state.images.length + ' 张图片';
      el.platformChip.textContent = platform;
      el.platformChip.hidden = false;
      el.timeChip.textContent = formatTime(session.createdAt || Date.now());
      el.timeChip.hidden = false;
      el.sourceLink.href = session.pageUrl || '#';
      el.sourceLink.hidden = !session.pageUrl;
      if (session.pageTitle) el.sourceLink.title = session.pageTitle;
    } else {
      el.tagline.textContent = '等待提取结果…';
      el.platformChip.hidden = true;
      el.timeChip.hidden = true;
      el.sourceLink.hidden = true;
    }

    render();
  }

  /* ======================= 渲染 ======================= */

  function render() {
    state.cards.clear();
    el.grid.textContent = '';

    const hasImages = state.images.length > 0;
    el.empty.hidden = hasImages;
    el.grid.hidden = !hasImages;

    if (!hasImages) {
      updateCounters();
      return;
    }

    const fragment = document.createDocumentFragment();
    state.images.forEach((item, i) => {
      fragment.appendChild(buildCard(item, i));
    });
    el.grid.appendChild(fragment);

    applyFilter();
    syncCheckboxes();
    updateCounters();
  }

  function buildCard(item, order) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = item.id;
    card.style.setProperty('--i', String(Math.min(order, 24)));

    const frame = document.createElement('label');
    frame.className = 'card__frame';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'card__check';
    checkbox.addEventListener('click', (e) => e.stopPropagation());

    const tick = document.createElement('span');
    tick.className = 'card__tick';

    const index = document.createElement('span');
    index.className = 'card__index';
    index.textContent = String(order + 1).padStart(3, '0');

    const img = document.createElement('img');
    img.className = 'card__img';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = item.id;
    img.src = item.thumb || item.url;

    const fail = document.createElement('span');
    fail.className = 'card__fail';
    const failTitle = document.createElement('b');
    failTitle.textContent = '预览加载失败';
    const failCode = document.createElement('code');
    failCode.textContent = item.thumb || item.url;
    fail.appendChild(failTitle);
    fail.appendChild(failCode);

    const status = document.createElement('span');
    status.className = 'card__status';

    img.addEventListener('error', () => { frame.classList.add('is-broken'); });
    img.addEventListener('load', () => { frame.classList.remove('is-broken'); });

    frame.appendChild(checkbox);
    frame.appendChild(tick);
    frame.appendChild(index);
    frame.appendChild(img);
    frame.appendChild(fail);
    frame.appendChild(status);

    const meta = document.createElement('div');
    meta.className = 'card__meta';

    const size = document.createElement('span');
    size.className = 'card__size';
    size.textContent = (item.width && item.height) ? (item.width + '×' + item.height) : '尺寸未知';

    const format = document.createElement('span');
    format.className = 'card__format';
    format.textContent = window.EMIUtils ? window.EMIUtils.guessFormat(item.url) : '图片';

    meta.appendChild(size);
    meta.appendChild(format);

    const actions = document.createElement('div');
    actions.className = 'card__actions';

    const link = document.createElement('a');
    link.className = 'card__open';
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = '原图 ↗';
    link.title = item.url;

    const grab = document.createElement('button');
    grab.type = 'button';
    grab.className = 'card__grab';
    grab.textContent = '↓ 单张下载';
    grab.title = '只下载这一张';
    grab.addEventListener('click', () => downloadSingle(item));

    actions.appendChild(link);
    actions.appendChild(grab);

    card.appendChild(frame);
    card.appendChild(meta);
    card.appendChild(actions);

    // 点击卡片选择 / Shift 连选（自己接管，便于实现区间选择）
    frame.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('button')) return;
      e.preventDefault();
      toggleCard(item.id, !state.selected.has(item.id), e.shiftKey);
    });
    checkbox.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggleCard(item.id, !state.selected.has(item.id), e.shiftKey);
      }
    });

    state.cards.set(item.id, { card, checkbox, status, frame, item });
    return card;
  }

  /* ======================= 选择逻辑 ======================= */

  function visibleIds() {
    const ids = [];
    state.cards.forEach((entry, id) => {
      if (!entry.card.classList.contains('is-hidden')) ids.push(id);
    });
    return ids;
  }

  function setSelected(id, checked) {
    const entry = state.cards.get(id);
    if (!entry) return;
    if (checked) state.selected.add(id); else state.selected.delete(id);
    entry.checkbox.checked = checked;
    entry.card.classList.toggle('is-selected', checked);
  }

  function toggleCard(id, checked, shift) {
    if (shift && state.anchorId && state.anchorId !== id) {
      const ids = visibleIds();
      const a = ids.indexOf(state.anchorId);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        const from = Math.min(a, b);
        const to = Math.max(a, b);
        for (let i = from; i <= to; i++) setSelected(ids[i], checked);
        state.anchorId = id;
        updateCounters();
        return;
      }
    }
    setSelected(id, checked);
    state.anchorId = id;
    updateCounters();
  }

  function syncCheckboxes() {
    state.cards.forEach((entry, id) => {
      const checked = state.selected.has(id);
      entry.checkbox.checked = checked;
      entry.card.classList.toggle('is-selected', checked);
    });
  }

  function selectAllVisible() {
    visibleIds().forEach((id) => setSelected(id, true));
    updateCounters();
  }

  function invertVisible() {
    visibleIds().forEach((id) => setSelected(id, !state.selected.has(id)));
    updateCounters();
  }

  function clearSelection() {
    state.selected.clear();
    syncCheckboxes();
    updateCounters();
  }

  function updateCounters() {
    el.selectedCount.textContent = String(state.selected.size);
    el.totalCount.textContent = String(state.images.length);
    const busy = state.downloading;
    el.btnDownload.disabled = busy || state.selected.size === 0;
    el.btnCancel.hidden = !busy;
  }

  /** 按最小尺寸筛选（以较短边为准） */
  function applyFilter() {
    const min = Number(el.minSizeSelect.value) || 0;
    state.cards.forEach((entry) => {
      const w = Number(entry.item.width) || 0;
      const h = Number(entry.item.height) || 0;
      const shortSide = (w && h) ? Math.min(w, h) : 0;
      const hidden = min > 0 && shortSide > 0 && shortSide < min;
      entry.card.classList.toggle('is-hidden', hidden);
    });
    // 被隐藏的图片自动取消勾选，避免误下载
    state.cards.forEach((entry, id) => {
      if (entry.card.classList.contains('is-hidden') && state.selected.has(id)) {
        setSelected(id, false);
      }
    });
    updateCounters();
  }

  /* ======================= 下载 ======================= */

  function buildDownloadItems(list) {
    return list.map((item) => ({
      id: item.id,
      index: item.index || 0,        // 用卡片序号命名，单张下载也能对上号
      url: item.url,
      altUrls: item.thumb && item.thumb !== item.url ? [item.thumb] : []
    }));
  }

  function selectedItems() {
    const list = [];
    state.images.forEach((item, i) => {
      if (!state.selected.has(item.id)) return;
      const entry = state.cards.get(item.id);
      if (entry && entry.card.classList.contains('is-hidden')) return;
      list.push(Object.assign({}, item, { index: i + 1 }));
    });
    return list;
  }

  async function startDownload(items) {
    if (state.downloading) return;
    if (!items.length) { toast('请先勾选要下载的图片', 'warn'); return; }

    savePrefs();
    setCardStatuses(items.map((i) => i.id), 'idle', '');

    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'EMI_DOWNLOAD',
        payload: {
          items: buildDownloadItems(items),
          prefix: state.prefs.prefix,
          pad: 3
        }
      });
    } catch (e) {
      toast('无法连接扩展后台：' + String(e && e.message || e), 'error');
      return;
    }
    if (!resp || !resp.ok) {
      toast('启动下载失败：' + ((resp && resp.error) || '未知错误'), 'error');
      return;
    }

    state.downloading = true;
    state.failedList = [];
    el.report.hidden = true;
    setProgress(0, items.length, 0, 0);
    el.progress.hidden = false;
    updateCounters();
    toast('开始下载 ' + items.length + ' 张图片，全部转换为 PNG', 'ok');
  }

  function downloadSingle(item) {
    if (state.downloading) { toast('正在批量下载中，请稍候', 'warn'); return; }
    const index = state.images.findIndex((x) => x.id === item.id) + 1;
    startDownload([Object.assign({}, item, { index: index || 1 })]);
  }

  function setProgress(done, total, ok, failed) {
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    el.progressFill.style.width = percent + '%';
    el.progressText.textContent = '进度 ' + done + ' / ' + total + '（' + percent + '%）';
    el.progressStat.textContent = '成功 ' + ok + ' · 失败 ' + failed;
  }

  function setCardStatuses(ids, status, text) {
    ids.forEach((id) => {
      const entry = state.cards.get(id);
      if (!entry) return;
      entry.status.dataset.status = status;
      entry.status.textContent = text || '';
      entry.status.classList.toggle('is-visible', status !== 'idle' && status !== '');
    });
  }

  function setCardStatus(id, status, text) {
    setCardStatuses([id], status, text);
  }

  function finishDownload(payload) {
    state.downloading = false;
    updateCounters();

    const results = (payload && payload.results) || [];
    const failed = results.filter((r) => !r.ok);
    const original = results.filter((r) => r.ok && r.mode === 'original');
    const totalBytes = results.reduce((sum, r) => sum + (r.bytes || 0), 0);

    // 回填每张卡片的状态
    results.forEach((r) => {
      if (r.ok) setCardStatus(r.id, r.mode === 'original' ? 'original' : 'done', r.mode === 'original' ? '原格式' : '已完成');
      else setCardStatus(r.id, 'failed', '失败');
    });

    // 取消 / 中断时，还停留在「转换中…」的卡片恢复为待下载
    state.cards.forEach((entry, id) => {
      if (entry.status.dataset.status === 'converting') setCardStatus(id, 'idle', '');
    });

    // 结果报告
    state.failedList = failed;
    el.report.hidden = false;
    el.reportTitle.textContent = payload && payload.state === 'cancelled' ? '下载已取消' : '下载结果';
    el.reportStats.textContent = '';

    const statOk = document.createElement('span');
    statOk.className = 'stat-ok';
    statOk.innerHTML = '成功 <b></b> 张';
    statOk.querySelector('b').textContent = String(results.length - failed.length);

    const statFail = document.createElement('span');
    statFail.className = 'stat-fail';
    statFail.innerHTML = '失败 <b></b> 张';
    statFail.querySelector('b').textContent = String(failed.length);

    const statSize = document.createElement('span');
    statSize.textContent = 'PNG 体积合计 ' + formatBytes(totalBytes);

    el.reportStats.appendChild(statOk);
    el.reportStats.appendChild(statFail);
    if (totalBytes > 0) el.reportStats.appendChild(statSize);

    if (original.length) {
      const statOriginal = document.createElement('span');
      statOriginal.textContent = '按原格式下载 ' + original.length + ' 张';
      el.reportStats.appendChild(statOriginal);
    }

    el.reportList.textContent = '';
    failed.forEach((r) => {
      const li = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = '#' + String(r.index).padStart(3, '0') + ' ' + (r.filename || '');
      const reason = document.createElement('span');
      reason.textContent = r.error || '未知错误';
      li.appendChild(name);
      li.appendChild(reason);
      el.reportList.appendChild(li);
    });
    el.btnCopyFailed.hidden = failed.length === 0;

    if (payload && payload.state === 'cancelled') {
      const done = results.length - failed.length;
      toast('已取消下载，取消前完成了 ' + done + ' 张', done > 0 ? 'warn' : 'info');
    } else if (failed.length === 0) {
      toast('全部下载完成，共 ' + results.length + ' 张 PNG', 'ok');
    } else if (failed.length === results.length) {
      toast('下载失败，请查看下方失败原因', 'error');
    } else {
      toast('完成 ' + (results.length - failed.length) + ' 张，失败 ' + failed.length + ' 张', 'warn');
    }
  }

  function applyProgressSnapshot(progress) {
    if (!progress || !progress.total) {
      el.progress.hidden = true;
      return;
    }
    const stale = progress.running && (Date.now() - (progress.startedAt || 0) > 10 * 60 * 1000);
    if (progress.running && !stale) {
      state.downloading = true;
      el.progress.hidden = false;
      setProgress(progress.done || 0, progress.total, progress.ok || 0, progress.failed || 0);
      // 已完成的卡片状态
      (progress.results || []).forEach((r) => {
        if (r.ok) setCardStatus(r.id, r.mode === 'original' ? 'original' : 'done', r.mode === 'original' ? '原格式' : '已完成');
        else setCardStatus(r.id, 'failed', '失败');
      });
    } else if (progress.state === 'done' || progress.state === 'cancelled') {
      el.progress.hidden = true;
    } else if (stale) {
      el.progress.hidden = true;
      toast('上一次下载任务被中断（浏览器或后台被关闭）', 'warn');
    }
    updateCounters();
  }

  /* ======================= 事件绑定 ======================= */

  function bindEvents() {
    el.btnAll.addEventListener('click', selectAllVisible);
    el.btnInvert.addEventListener('click', invertVisible);
    el.btnNone.addEventListener('click', clearSelection);

    el.btnDownload.addEventListener('click', () => startDownload(selectedItems()));

    el.btnCancel.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'EMI_CANCEL_DOWNLOAD' });
      toast('已请求取消，正在等待当前图片处理完成…', 'warn');
    });

    el.btnRescan.addEventListener('click', async () => {
      el.btnRescan.disabled = true;
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'EMI_RESCAN' });
        if (resp && resp.ok) toast('已触发重新提取，完成后本页会自动刷新', 'ok');
        else toast('重新获取失败：' + ((resp && resp.error) || '未知错误'), 'error');
      } finally {
        el.btnRescan.disabled = false;
      }
    });

    el.btnClear.addEventListener('click', async () => {
      if (!confirm('确定要清除当前提取结果吗？')) return;
      await chrome.runtime.sendMessage({ type: 'EMI_CLEAR_SESSION' });
      state.selected.clear();
      el.report.hidden = true;
      el.progress.hidden = true;
      applySession(null);
      toast('已清除提取结果', 'ok');
    });

    el.minSizeSelect.addEventListener('change', applyFilter);

    el.prefixInput.addEventListener('input', updateFooterRule);
    el.prefixInput.addEventListener('change', savePrefs);
    el.minSizeSelect.addEventListener('change', savePrefs);

    el.btnCopyFailed.addEventListener('click', async () => {
      const text = state.failedList
        .map((r) => '#' + String(r.index).padStart(3, '0') + ' ' + (r.filename || '') + ' —— ' + (r.error || '未知错误'))
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast('失败清单已复制到剪贴板', 'ok');
      } catch (e) {
        toast('复制失败，请手动选择文本', 'error');
      }
    });

    // 键盘快捷键：⌘/Ctrl + A 全选，Esc 取消选择
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' && e.target.type === 'text') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAllVisible();
      } else if (e.key === 'Escape') {
        clearSelection();
      }
    });
  }

  /* ======================= 与 Service Worker 通信 ======================= */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return undefined;

    switch (msg.type) {
      case 'EMI_SESSION_UPDATED':
        refreshSession();
        toast('已更新为最新的提取结果', 'ok');
        sendResponse({ ok: true });
        return false;

      case 'EMI_ITEM_STATE':
        if (msg.payload && msg.payload.id) setCardStatus(msg.payload.id, 'converting', '转换中…');
        return undefined;

      case 'EMI_PROGRESS': {
        const p = msg.payload || {};
        if (typeof p.total === 'number' && p.total > 0) {
          el.progress.hidden = false;
          setProgress(p.done || 0, p.total, p.ok || 0, p.failed || 0);
        }
        if (p.last) {
          setCardStatus(
            p.last.id,
            p.last.ok ? (p.last.mode === 'original' ? 'original' : 'done') : 'failed',
            p.last.ok ? (p.last.mode === 'original' ? '原格式' : '已完成') : '失败'
          );
        }
        return undefined;
      }

      case 'EMI_FINISHED':
        finishDownload(msg.payload);
        return undefined;

      /* 大图保存通道：Service Worker 把转好的 PNG base64 交过来，
         本页用 blob URL 交给 chrome.downloads 保存 */
      case 'EMI_SAVE_VIA_BLOB': {
        const payload = msg.payload || {};
        sendResponse({ accepted: true });
        handleBlobSave(payload);
        return false;
      }

      default:
        return undefined;
    }
  });

  async function handleBlobSave(payload) {
    let ok = false;
    try {
      const bytes = base64ToBytes(payload.base64);
      const blob = new Blob([bytes], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      try {
        const downloadId = await new Promise((resolve, reject) => {
          chrome.downloads.download(
            { url, filename: payload.filename, conflictAction: 'uniquify', saveAs: false },
            (id) => {
              const err = chrome.runtime.lastError;
              if (err || id == null) reject(new Error(err ? err.message : '创建下载任务失败'));
              else resolve(id);
            }
          );
        });
        await waitDownloadDone(downloadId);
        ok = true;
      } finally {
        // 等下载真正开始后再回收 blob URL
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e) {
      ok = false;
    } finally {
      try {
        chrome.runtime.sendMessage({
          type: 'EMI_BLOB_SAVE_RESULT',
          payload: { reqId: payload.reqId, ok }
        });
      } catch (e) { /* 忽略 */ }
    }
  }

  /* ======================= 启动 ======================= */

  init().catch((e) => {
    toast('初始化失败：' + String(e && e.message || e), 'error');
  });
})();
