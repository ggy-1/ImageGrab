/**
 * 图提取 ImageGrab — 官网交互脚本
 * ---------------------------------------------------------------------------
 * 纯原生 JS，无依赖，双击 index.html 即可运行。
 * 一共做五件事：
 *   1. 页面滚动后给导航栏加吸顶样式（毛玻璃 + 阴影）
 *   2. 移动端汉堡菜单的展开 / 收起
 *   3. 滚动时高亮导航里当前所在的区块
 *   4. 元素进入视口时淡入上移（IntersectionObserver）
 *   5. 页脚年份自动取当前年份
 *
 * 所有初始化都做了存在性判断：某个区块被删掉，脚本也不会报错。
 * 系统开启「减少动态效果」时，动画全部跳过，直接显示最终状态。
 */
(function () {
  'use strict';

  var docEl = document.documentElement;
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** 用 requestAnimationFrame 节流的滚动处理，一帧只算一次 */
  function onScrollThrottled(handler) {
    var ticking = false;
    return function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        ticking = false;
        handler();
      });
    };
  }

  /* =========================================================================
     1. 吸顶导航样式
     滚过一小段距离就给 header 加 .is-stuck，底边线和阴影一起出现。
     ========================================================================= */
  function initStickyHeader() {
    var header = document.getElementById('siteHeader');
    if (!header) return;

    var threshold = 8; // 滚动超过 8px 就算进入吸顶状态，避免抖动

    var update = onScrollThrottled(function () {
      header.classList.toggle('is-stuck', window.scrollY > threshold);
    });

    window.addEventListener('scroll', update, { passive: true });
    update(); // 刷新页面时如果停在中间位置，状态也要对
  }

  /* =========================================================================
     2. 移动端汉堡菜单
     展开状态同时写在 aria-expanded 上，方便读屏和样式各自使用。
     ========================================================================= */
  function initMobileNav() {
    var toggle = document.getElementById('navToggle');
    var menu = document.getElementById('navMenu');
    if (!toggle || !menu) return;

    var desktopQuery = window.matchMedia('(min-width: 768px)');

    function setOpen(open) {
      menu.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? '收起导航菜单' : '打开导航菜单');
    }

    function isOpen() {
      return toggle.getAttribute('aria-expanded') === 'true';
    }

    toggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });

    // 点任意导航项后自动收起，免得菜单挡住目标区块
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });

    // Esc 收起，并把焦点还给按钮
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });

    // 点菜单外面收起
    document.addEventListener('click', function (event) {
      if (!isOpen()) return;
      if (event.target.closest('#navMenu') || event.target.closest('#navToggle')) return;
      setOpen(false);
    });

    // 拉宽到桌面断点时复位，防止残留展开状态
    var handleBreakpoint = function (event) {
      if (event.matches) setOpen(false);
    };
    if (typeof desktopQuery.addEventListener === 'function') {
      desktopQuery.addEventListener('change', handleBreakpoint);
    } else if (typeof desktopQuery.addListener === 'function') {
      desktopQuery.addListener(handleBreakpoint); // 兼容旧版
    }
  }

  /* =========================================================================
     3. 导航高亮当前区块
     用 IntersectionObserver 在视口中部取一条横带，落在带子里的区块即当前区块。
     ========================================================================= */
  function initScrollSpy() {
    var links = Array.prototype.slice.call(document.querySelectorAll('[data-spy-link]'));
    if (!links.length || !('IntersectionObserver' in window)) return;

    // 取出每个导航项对应的区块，按文档顺序排列
    var sections = links
      .map(function (link) {
        var id = link.getAttribute('href');
        return id && id.charAt(0) === '#' ? document.querySelector(id) : null;
      })
      .filter(Boolean);

    if (!sections.length) return;

    var visible = {};
    var currentId = '';

    function setActive(id) {
      if (id === currentId) return;
      currentId = id;
      links.forEach(function (link) {
        var isActive = link.getAttribute('href') === '#' + id;
        if (isActive) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visible[entry.target.id] = true;
        else delete visible[entry.target.id];
      });

      // 按文档顺序取第一个落在带子里的区块，避免多个同时命中时来回跳
      var active = sections.filter(function (section) { return visible[section.id]; })[0];
      if (active) setActive(active.id);
    }, {
      // 上下各切掉一部分，只在视口中段判断，滚动到哪一段很明确
      rootMargin: '-45% 0px -50% 0px'
    });

    sections.forEach(function (section) { observer.observe(section); });
  }

  /* =========================================================================
     4. 滚动淡入
     [data-reveal] 进入视口后加 .is-visible。
     [data-reveal-stagger] 的子元素按顺序依次入场，间隔 70ms、最多错开 6 个。
     ========================================================================= */
  function initReveal() {
    var items = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
    if (!items.length) return;

    // 系统要求减少动态：直接显示，不注册观察器
    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
      items.forEach(function (item) { item.classList.add('is-visible'); });
      return;
    }

    // 先算好错峰延迟
    Array.prototype.slice.call(document.querySelectorAll('[data-reveal-stagger]'))
      .forEach(function (group) {
        Array.prototype.slice.call(group.children).forEach(function (child, index) {
          if (!child.hasAttribute('data-reveal')) return;
          var step = Math.min(index, 6);
          child.style.setProperty('--reveal-delay', (step * 70) + 'ms');
        });
      });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target); // 只播一次
      });
    }, {
      threshold: 0.12,
      rootMargin: '0px 0px -6% 0px'
    });

    items.forEach(function (item) { observer.observe(item); });
  }

  /* =========================================================================
     5. 页脚年份
     ========================================================================= */
  function initFooterYear() {
    var year = document.getElementById('year');
    if (!year) return;
    year.textContent = String(new Date().getFullYear());
  }

  /* =========================================================================
     启动
     ========================================================================= */
  function init() {
    initStickyHeader();
    initMobileNav();
    initScrollSpy();
    initReveal();
    initFooterYear();

    // 动画跑完后摘掉 will-change，减少长时间占用的合成层
    window.setTimeout(function () {
      docEl.style.setProperty('--reveal-delay', '0s');
      Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'))
        .forEach(function (item) { item.style.willChange = 'auto'; });
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
