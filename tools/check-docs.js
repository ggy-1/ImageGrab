/**
 * docs 官网自检脚本（Node，无浏览器也能跑）
 * ---------------------------------------------------------------------------
 * 官网要求「纯静态、双击 index.html 就能打开」，所以这里检查的都是会破坏
 * 这条底线的问题：
 *   1. 三个文件（index.html / css/style.css / js/main.js）是否都在；
 *   2. 有没有引用外部资源（外链 CSS/JS/图片、CSS 里的 url(http...) 与 @import），
 *      外链会让页面离线打不开；
 *   3. HTML 里引用的本地文件是否真实存在（防止改名后 404）；
 *   4. JS 是否通过 Node 语法解析；
 *   5. 无障碍与规范的小检查：lang、viewport、h1 唯一、图片有 alt、只用了语义化标签。
 *
 * 用法：node tools/check-docs.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const HTML = path.join(DOCS, 'index.html');
const CSS = path.join(DOCS, 'css', 'style.css');
const JS = path.join(DOCS, 'js', 'main.js');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
  }
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

console.log('----------------------------------------');
console.log('[文件结构]');

const html = read(HTML);
const css = read(CSS);
const js = read(JS);

check('docs/index.html 存在', !!html);
check('docs/css/style.css 存在', !!css);
check('docs/js/main.js 存在', !!js);

if (!html || !css || !js) {
  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(1);
}

console.log('\n[没有外部依赖]');

// 资源引用（src / link href）里不允许出现 http(s)，否则离线双击打不开
const resourceRefs = [];
html.replace(/<script[^>]*\ssrc="([^"]+)"/gi, (m, url) => resourceRefs.push(url));
html.replace(/<link[^>]*\shref="([^"]+)"/gi, (m, url) => {
  if (/rel="(stylesheet|icon|preload)"/i.test(m)) resourceRefs.push(url);
  return m;
});
resourceRefs.forEach((url) => {
  if (/^(https?:)?\/\//i.test(url)) check('资源不引用外部地址：' + url, false, '会依赖网络');
});
check('HTML 里的 CSS/JS/图标都不引用外部地址', resourceRefs.every((u) => !/^(https?:)?\/\//i.test(u)));

// CSS 里的 @import / url() 也不能是外部地址
const cssImports = (css.match(/@import[^;]+;/gi) || []);
const cssUrls = (css.match(/url\(([^)]+)\)/gi) || []);
check('CSS 没有 @import', cssImports.length === 0, cssImports.join(' '));
check('CSS 里的 url() 不引用外部地址', cssUrls.every((u) => !/https?:/i.test(u)));

// 外链锚点（如 GitHub 占位）是允许的，这里只做提示
const anchors = (html.match(/<a[^>]*\shref="(https?:[^"]+)"/gi) || [])
  .map((m) => m.replace(/.*href="([^"]+)".*/, '$1'));
console.log('  · 外部链接锚点（允许，属于跳转不是依赖）：' + (anchors.length ? anchors.join(', ') : '无'));

console.log('\n[本地引用完整性]');

const localRefs = resourceRefs.filter((u) => !/^(https?:|data:|#)/i.test(u));
localRefs.forEach((url) => {
  const target = path.join(DOCS, url.split('?')[0]);
  check('引用的文件存在：' + url, fs.existsSync(target));
});

console.log('\n[脚本可执行性]');

try {
  new vm.Script(js);
  check('js/main.js 通过语法解析', true);
} catch (e) {
  check('js/main.js 通过语法解析', false, e.message);
}

console.log('\n[语义化与无障碍]');

check('html 声明了语言', /<html[^>]*\slang="zh-CN"/i.test(html));
check('声明了 viewport（响应式前提）', /<meta[^>]+name="viewport"[^>]+width=device-width/i.test(html));
check('只有一个 h1', (html.match(/<h1[\s>]/gi) || []).length === 1);
check('使用了语义化标签 header/nav/main/section/footer',
  ['header', 'nav', 'main', 'section', 'footer'].every((tag) => new RegExp('<' + tag + '[\\s>]', 'i').test(html)));
check('所有 img 都带 alt', (html.match(/<img[^>]*>/gi) || []).every((tag) => /\salt="/i.test(tag)));
check('装饰性 SVG 都标记了 aria-hidden',
  (html.match(/<svg[^>]*>/gi) || []).every((tag) => /aria-hidden="true"/i.test(tag)));
check('汉堡按钮带 aria-expanded 与 aria-controls',
  /aria-expanded="false"/i.test(html) && /aria-controls="/i.test(html));
check('配色与间距用 CSS 变量统一管理', (css.match(/--[a-z0-9-]+:/gi) || []).length >= 20);
check('主色可以在 :root 一处修改', /:root\s*\{[\s\S]*?--primary:/i.test(css));
check('提供 prefers-reduced-motion 降级', /prefers-reduced-motion/i.test(css));
check('提供键盘焦点样式', /:focus-visible/i.test(css));

console.log('\n[响应式断点]');

check('包含 ≥768px 的平板断点', /@media\s*\(min-width:\s*768px\)/i.test(css));
check('包含 ≥1024px 的桌面断点', /@media\s*\(min-width:\s*1024px\)/i.test(css));
check('尺寸使用了 clamp()（字体/间距随屏幕缩放）', /clamp\(/i.test(css));
check('网格在窄屏为单列', /grid-template-columns:\s*1fr;/i.test(css));

console.log('----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
