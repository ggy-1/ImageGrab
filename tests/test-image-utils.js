/**
 * tests/test-image-utils.js
 * 纯 Node 单元测试：验证 lib/image-utils.js 的地址归一化、原图还原、过滤、命名等逻辑。
 * 运行： node tests/test-image-utils.js
 */
'use strict';

const assert = require('assert');
const U = require('../lib/image-utils.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
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

const BASE = 'https://detail.tmall.com/item.htm?id=123';

console.log('\n[normalizeUrl] 相对路径补全与协议处理');
test('协议相对地址补全为 https', () => {
  assert.strictEqual(
    U.normalizeUrl('//img.alicdn.com/imgextra/a.jpg', BASE),
    'https://img.alicdn.com/imgextra/a.jpg'
  );
});
test('站内绝对路径补全为完整 URL', () => {
  assert.strictEqual(
    U.normalizeUrl('/img/a.png', 'https://item.jd.com/100.html'),
    'https://item.jd.com/img/a.png'
  );
});
test('data: / blob: / javascript: 一律丢弃', () => {
  assert.strictEqual(U.normalizeUrl('data:image/png;base64,AAAA', BASE), null);
  assert.strictEqual(U.normalizeUrl('blob:https://a.com/xyz', BASE), null);
  assert.strictEqual(U.normalizeUrl('javascript:void(0)', BASE), null);
});
test('去掉引号与 url() 包装', () => {
  assert.strictEqual(
    U.normalizeUrl('url("https://img.alicdn.com/a.jpg")', BASE),
    'https://img.alicdn.com/a.jpg'
  );
});
test('还原 JSON 中被转义的斜杠', () => {
  assert.strictEqual(
    U.normalizeUrl('https:\\/\\/img.alicdn.com\\/a.jpg', BASE),
    'https://img.alicdn.com/a.jpg'
  );
});
test('空值与纯锚点返回 null', () => {
  assert.strictEqual(U.normalizeUrl('', BASE), null);
  assert.strictEqual(U.normalizeUrl('   ', BASE), null);
  assert.strictEqual(U.normalizeUrl('#top', BASE), null);
  assert.strictEqual(U.normalizeUrl(null, BASE), null);
});

console.log('\n[upgradeToOriginal] 平台差异：缩略图 -> 原图');
test('淘宝 / 阿里 CDN 尺寸与质量后缀', () => {
  assert.strictEqual(
    U.upgradeToOriginal('https://img.alicdn.com/imgextra/i1/123/O1CN01abc.jpg_430x430q90.jpg'),
    'https://img.alicdn.com/imgextra/i1/123/O1CN01abc.jpg'
  );
  assert.strictEqual(
    U.upgradeToOriginal('https://img.alicdn.com/imgextra/i1/123/O1CN01abc.jpg_.webp'),
    'https://img.alicdn.com/imgextra/i1/123/O1CN01abc.jpg'
  );
  assert.strictEqual(
    U.upgradeToOriginal('https://gw.alicdn.com/bao/uploaded/i3/T1abc.jpg_Q75.jpg'),
    'https://gw.alicdn.com/bao/uploaded/i3/T1abc.jpg'
  );
});
test('京东 n1/s450x450 前缀', () => {
  assert.strictEqual(
    U.upgradeToOriginal('https://img14.360buyimg.com/n1/s450x450_jfs/t1/123/45/678/12345/abc.jpg'),
    'https://img14.360buyimg.com/n0/jfs/t1/123/45/678/12345/abc.jpg'
  );
});
test('拼多多图片处理参数与尺寸后缀', () => {
  assert.strictEqual(
    U.upgradeToOriginal('https://img.pddpic.com/gaudit-image/a/abc.jpeg?imageMogr2/thumbnail/450x450'),
    'https://img.pddpic.com/gaudit-image/a/abc.jpeg'
  );
  assert.strictEqual(
    U.upgradeToOriginal('https://t00img.yangkeduo.com/goods/images/abc_450x450.jpg'),
    'https://t00img.yangkeduo.com/goods/images/abc.jpg'
  );
});
test('未知域名原样保留（只尝试通用后缀清理）', () => {
  assert.strictEqual(
    U.upgradeToOriginal('https://cdn.example.com/a/b/photo.jpg'),
    'https://cdn.example.com/a/b/photo.jpg'
  );
});

console.log('\n[dedupeKey] 去重键');
test('同图不同尺寸视为同一张', () => {
  const a = U.upgradeToOriginal('https://img.alicdn.com/i1/a.jpg_430x430q90.jpg');
  const b = U.upgradeToOriginal('https://img.alicdn.com/i1/a.jpg_800x800q90.jpg');
  assert.strictEqual(U.dedupeKey(a), U.dedupeKey(b));
});
test('不同图片不会被误判为同一张', () => {
  assert.notStrictEqual(
    U.dedupeKey('https://img.alicdn.com/i1/a.jpg'),
    U.dedupeKey('https://img.alicdn.com/i1/b.jpg')
  );
});

console.log('\n[parseSrcset] srcset 解析');
test('按宽度倒序返回候选', () => {
  const list = U.parseSrcset('a.jpg 300w, b.jpg 1200w, c.jpg 600w');
  assert.deepStrictEqual(list.map((x) => x.url), ['b.jpg', 'c.jpg', 'a.jpg']);
});
test('支持密度描述符与空值', () => {
  assert.deepStrictEqual(U.parseSrcset('a.jpg 1x, b.jpg 2x').map((x) => x.url), ['b.jpg', 'a.jpg']);
  assert.deepStrictEqual(U.parseSrcset(''), []);
  assert.deepStrictEqual(U.parseSrcset(null), []);
});

console.log('\n[extractUrlsFromCssValue] 背景图抽取');
test('多背景层与引号变体', () => {
  const urls = U.extractUrlsFromCssValue(
    'url("https://img.alicdn.com/a.jpg"), url(https://img.alicdn.com/b.png), linear-gradient(#fff, #000)'
  );
  assert.deepStrictEqual(urls, ['https://img.alicdn.com/a.jpg', 'https://img.alicdn.com/b.png']);
});
test('none 返回空数组', () => {
  assert.deepStrictEqual(U.extractUrlsFromCssValue('none'), []);
});

console.log('\n[extractUrlsFromText] 内联脚本 / 样式扫描');
test('抽取藏在内联 JSON 里的图片地址', () => {
  const text = 'var data={"pic":"https:\\/\\/img.alicdn.com\\/imgextra\\/i1\\/a.jpg","x":1};';
  const urls = U.extractUrlsFromText(text);
  assert.deepStrictEqual(urls, ['https://img.alicdn.com/imgextra/i1/a.jpg']);
});
test('忽略非图片链接', () => {
  assert.deepStrictEqual(U.extractUrlsFromText('https://www.taobao.com/index.html'), []);
});

console.log('\n[isLikelyNonProductImage] 干扰图过滤');
test('过滤图标 / logo / 二维码 / 水印 / 埋点', () => {
  [
    'https://img.alicdn.com/tps/i3/T1logo.png',
    'https://img.alicdn.com/imgextra/i1/icon_cart.png',
    'https://img.alicdn.com/qrcode.png',
    'https://example.com/watermark.png',
    'https://hm.baidu.com/beacon.gif',
    'https://img.alicdn.com/1x1.png',
    'https://img.alicdn.com/logo.svg'
  ].forEach((u) => assert.strictEqual(U.isLikelyNonProductImage(u), true, u));
});
test('保留正常商品图', () => {
  [
    'https://img.alicdn.com/imgextra/i1/2200712345/O1CN01abc.jpg',
    'https://img14.360buyimg.com/n0/jfs/t1/123/45/678/12345/abc.jpg',
    'https://img.pddpic.com/gaudit-image/2026-01-01/xyz.jpeg'
  ].forEach((u) => assert.strictEqual(U.isLikelyNonProductImage(u), false, u));
});
test('非 http 地址视为不可用', () => {
  assert.strictEqual(U.isLikelyNonProductImage('data:image/png;base64,AA'), true);
});

console.log('\n[isSizeOk] 尺寸过滤');
test('小于 100x100 不通过，未知尺寸放行', () => {
  assert.strictEqual(U.isSizeOk(99, 400, 100, 100), false);
  assert.strictEqual(U.isSizeOk(100, 100, 100, 100), true);
  assert.strictEqual(U.isSizeOk(1, 1, 100, 100), false);
  assert.strictEqual(U.isSizeOk(0, 0, 100, 100), true);
});

console.log('\n[buildFilename] 文件名规则');
test('序号补零到 3 位', () => {
  assert.strictEqual(U.buildFilename('商品图', 1, 3, 'png'), '商品图_001.png');
  assert.strictEqual(U.buildFilename('商品图', 12, 3, 'png'), '商品图_012.png');
  assert.strictEqual(U.buildFilename('商品图', 1234, 3, 'png'), '商品图_1234.png');
});
test('清理非法字符并回退默认前缀', () => {
  assert.strictEqual(U.buildFilename('a/b:c*?"<>|', 1, 3, 'png'), 'abc_001.png');
  assert.strictEqual(U.buildFilename('   ', 1, 3, 'png'), '商品图_001.png');
  assert.strictEqual(U.buildFilename(null, 1, 3, 'png'), '商品图_001.png');
});
test('支持其他扩展名（原格式兜底时使用）', () => {
  assert.strictEqual(U.buildFilename('商品图', 7, 3, 'jpg'), '商品图_007.jpg');
});

console.log('\n[guessFormat / guessMimeFromUrl] 格式识别');
test('识别常见格式', () => {
  assert.strictEqual(U.guessFormat('https://a.com/x.JPG'), 'JPG');
  assert.strictEqual(U.guessFormat('https://a.com/x.webp?x=1'), 'WEBP');
  assert.strictEqual(U.guessFormat('https://a.com/x'), '未知');
  assert.strictEqual(U.guessMimeFromUrl('https://a.com/x.png'), 'image/png');
});

console.log('\n----------------------------------------');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
