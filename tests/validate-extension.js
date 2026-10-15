/**
 * tests/validate-extension.js
 * ---------------------------------------------------------------------------
 * 交付前的静态自检：确保这个目录可以直接用「加载已解压的扩展程序」载入，
 * 且不会因为缺文件、MV3 权限不合法、内联脚本违规等低级问题报错。
 * 运行： node tests/validate-extension.js
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

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

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let manifest = null;
ok('manifest.json 是合法 JSON', () => {
  manifest = JSON.parse(read('manifest.json'));
  assert.strictEqual(typeof manifest, 'object');
});

console.log('\n[Manifest V3 与权限]');
ok('使用 Manifest V3', () => {
  assert.strictEqual(manifest.manifest_version, 3);
  assert.ok(manifest.background && manifest.background.service_worker, '缺少 service worker 声明');
  assert.ok(!manifest.background.scripts, 'MV3 不允许 background.scripts');
  assert.ok(!manifest.background.persistent, 'MV3 不允许 persistent');
});
ok('包含 activeTab / scripting / downloads / storage 权限', () => {
  ['activeTab', 'scripting', 'downloads', 'storage'].forEach((p) => {
    assert.ok(manifest.permissions.indexOf(p) !== -1, '缺少权限：' + p);
  });
});
ok('host_permissions 覆盖三个平台的业务域名与图片 CDN', () => {
  const hosts = manifest.host_permissions.join(' ');
  ['*.taobao.com', '*.tmall.com', '*.jd.com', '*.pinduoduo.com', '*.yangkeduo.com',
    '*.alicdn.com', '*.360buyimg.com', '*.pddpic.com'].forEach((h) => {
    assert.ok(hosts.indexOf(h) !== -1, '缺少域名：' + h);
  });
});
ok('content_scripts 注入五个平台域名且只在顶层文档', () => {
  const cs = manifest.content_scripts[0];
  const matches = cs.matches.join(' ');
  ['*.taobao.com', '*.tmall.com', '*.jd.com', '*.pinduoduo.com', '*.yangkeduo.com'].forEach((h) => {
    assert.ok(matches.indexOf(h) !== -1, '缺少匹配：' + h);
  });
  assert.strictEqual(cs.all_frames, false, 'all_frames 应为 false，避免 iframe 重复注入');
  assert.deepStrictEqual(cs.js, ['lib/image-utils.js', 'content.js'], '注入顺序应为工具库在前');
});
ok('content.css 已声明为 web_accessible_resources（内容脚本要 fetch 它）', () => {
  const war = manifest.web_accessible_resources || [];
  const entry = war.find((w) => w.resources.indexOf('content.css') !== -1);
  assert.ok(entry, '缺少 content.css 的可访问声明');
  assert.ok(entry.matches.join(' ').indexOf('*.taobao.com') !== -1, 'matches 未覆盖平台域名');
});

console.log('\n[文件完整性]');
ok('manifest 里引用的文件全部存在', () => {
  const files = [
    manifest.background.service_worker,
    ...manifest.content_scripts[0].js,
    ...Object.values(manifest.icons || {}),
    ...Object.values((manifest.action && manifest.action.default_icon) || {}),
    ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources)
  ];
  files.forEach((f) => assert.ok(exists(f), '文件不存在：' + f));
});
ok('预览页及其资源存在', () => {
  ['gallery.html', 'gallery.js', 'gallery.css', 'lib/image-utils.js'].forEach((f) => {
    assert.ok(exists(f), '文件不存在：' + f);
  });
});
ok('图标是合法 PNG 且尺寸正确', () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const iconDir = path.join(ROOT, 'icons');
  fs.readdirSync(iconDir).forEach((name) => {
    const buf = fs.readFileSync(path.join(iconDir, name));
    assert.ok(buf.subarray(0, 8).equals(sig), name + ' 不是 PNG');
    const size = Number((/icon(\d+)\.png/.exec(name) || [])[1]);
    assert.strictEqual(buf.readUInt32BE(16), size, name + ' 宽度不符');
    assert.strictEqual(buf.readUInt32BE(20), size, name + ' 高度不符');
  });
});

console.log('\n[MV3 CSP 合规]');
ok('gallery.html 没有内联 <script> 或事件属性', () => {
  const html = read('gallery.html');
  const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
  assert.strictEqual(inlineScripts.length, 0, '发现内联脚本，会被 MV3 CSP 拦截');
  const handlers = html.match(/\son[a-z]+\s*=\s*["']/gi) || [];
  assert.strictEqual(handlers.length, 0, '发现内联事件属性：' + handlers.join(','));
});
ok('gallery.html 引用的静态资源都存在', () => {
  const html = read('gallery.html');
  const refs = [
    ...(html.match(/<script[^>]+src="([^"]+)"/gi) || []),
    ...(html.match(/<link[^>]+href="([^"]+)"/gi) || [])
  ].map((tag) => /(?:src|href)="([^"]+)"/i.exec(tag)[1]);
  assert.ok(refs.length >= 3, '没有找到资源引用');
  refs.forEach((r) => {
    assert.ok(!/^https?:/i.test(r), '扩展页面不应依赖外链资源：' + r);
    assert.ok(exists(r), '引用的资源不存在：' + r);
  });
});
ok('Service Worker 使用 importScripts 而非 ESM import', () => {
  const bg = read('background.js');
  assert.ok(/importScripts\(\s*['"]lib\/image-utils\.js['"]\s*\)/.test(bg), '缺少 importScripts');
  assert.ok(!/^\s*import\s/m.test(bg), 'MV3 经典 Service Worker 不支持 import 语句');
});

console.log('\n[脚本可执行性]');
ok('所有脚本都能通过 Node 语法解析', () => {
  ['lib/image-utils.js', 'content.js', 'background.js', 'gallery.js'].forEach((f) => {
    assert.doesNotThrow(() => { new vm.Script(read(f), { filename: f }); }, f + ' 存在语法错误');
  });
});
ok('内容脚本与预览页都复用了 lib/image-utils.js', () => {
  assert.ok(/window\.EMIUtils/.test(read('content.js')), 'content.js 未使用共享工具库');
  assert.ok(/window\.EMIUtils/.test(read('gallery.js')), 'gallery.js 未使用共享工具库');
  assert.ok(/self\.EMIUtils/.test(read('background.js')), 'background.js 未使用共享工具库');
});
ok('按钮样式与卡片样式确实定义在 CSS 文件里', () => {
  assert.ok(/\.emi-fab\b/.test(read('content.css')), 'content.css 缺少 .emi-fab');
  assert.ok(/\.card__tick\b/.test(read('gallery.css')), 'gallery.css 缺少卡片样式');
  assert.ok(/@media/.test(read('gallery.css')), 'gallery.css 缺少响应式断点');
});

console.log('\n----------------------------------------');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
