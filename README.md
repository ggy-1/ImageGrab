# 电商图片提取下载器（Chrome 扩展 · Manifest V3）

在**淘宝 / 天猫 / 京东 / 拼多多（含商家版）**的商品详情页一键提取页面内全部商品图片，
集中到预览页勾选，批量下载为 **PNG**。

---

## 一、安装

1. 打开 Chrome，地址栏输入 `chrome://extensions` 回车。
2. 打开右上角的 **开发者模式** 开关。
3. 点击 **加载已解压的扩展程序**，选择本目录（含 `manifest.json` 的那一层）。
4. 加载成功后工具栏会出现扩展图标；如果图标没显示，点击拼图按钮把它固定出来。

> 因为 `manifest.json` 里声明了 `host_permissions`，安装/首次运行时会提示扩展可以访问
> 淘宝、天猫、京东、拼多多及相关图片 CDN 的数据，选「允许」即可。

---

## 二、使用

1. 打开任意一个商品详情页，例如：
   - 淘宝：`https://item.taobao.com/item.htm?id=...`
   - 天猫：`https://detail.tmall.com/item.htm?id=...`
   - 京东：`https://item.jd.com/100012043978.html`
   - 拼多多 / 商家版：`https://mobile.yangkeduo.com/goods.html?goods_id=...`、`https://mms.pinduoduo.com/...`
2. 页面右下角会出现悬浮按钮 **「获取图片」**（只在商品详情页出现，其他页面不注入）。
3. 点击后按钮进入「正在扫描」状态：它会先自动上下滚动一遍页面触发懒加载，
   再解析页面上的所有图片地址并校验尺寸（约 1～5 秒，图片多时更久）。
4. 提取完成后自动打开扩展的 **预览页**，网格展示每一张图片的缩略图、尺寸、格式。
5. 在预览页里勾选需要的图片（支持全选 / 反选 / Shift 连选 / 按最小尺寸筛选），
   填写文件名前缀，点击 **「下载选中（PNG）」**。
6. 顶部进度条与每张卡片的状态会实时显示进度，结束后弹出结果报告（成功 / 失败 / 体积）。
   文件保存在浏览器默认下载目录，命名规则 `商品图_001.png`（序号自动补零到 3 位）。

按下工具栏图标也可以随时回到预览页。

---

## 三、目录结构

```
ecommerce-image-extractor/
├── manifest.json           # MV3 配置：权限、注入规则、图标
├── background.js           # Service Worker：消息路由、PNG 转换、下载、进度广播
├── content.js              # 内容脚本：判定详情页 + 注入按钮 + 扫描图片
├── content.css             # 悬浮按钮与轻提示样式（Shadow DOM 内生效）
├── gallery.html            # 预览页结构
├── gallery.css             # 预览页样式（暗色接触印相风格，响应式网格）
├── gallery.js              # 预览页逻辑：渲染、勾选、下载、进度、结果报告
├── lib/
│   └── image-utils.js      # 纯函数工具库：URL 归一化 / 原图还原 / 过滤 / 命名
├── icons/                  # 16 / 32 / 48 / 128 图标
├── tools/make-icons.ps1    # 图标生成脚本（可重复执行）
├── tools/preview-button.html   # 悬浮按钮的离线预览（不动扩展也能看样式）
├── tools/preview-gallery.html  # 预览页的离线预览（桩数据 + 模拟下载流程）
└── tests/                  # 自测脚本（Node，无浏览器也能跑）
```

---

## 四、实现思路

### 1. 只在商品详情页注入按钮

`content.js` 用三级判定，避免在首页、搜索页、购物车、登录页误注入：

1. **URL 反例**：`login / passport / cart / order / pay / search` 等路径或子域名直接排除；
2. **URL 正例**：`item.taobao.com/item.htm`、`item.jd.com/\d+.html`、`goods.html?goods_id=` 等；
3. **DOM 特征兜底**：`#J_DetailMeta`、`#spec-img`、`.sku-name`、`[class*="goods-detail"]` 等，
   再叠加「页面上 ≥300×300 的大图不少于 3 张」。
4. SPA 路由变化（`pushState` / `popstate` / URL 轮询）会重新判定；
   未显示按钮时最多重试 20 次，避免在非详情页长期消耗性能。

按钮用 **Shadow DOM + 构造样式表（CSSStyleSheet）** 渲染：页面 CSS 影响不到按钮，
按钮也不会污染页面；即使页面 CSP 很严格，构造样式表也不受 `style-src` 限制。

### 2. 图片提取

- **来源全覆盖**：`img[src|currentSrc]`、`srcset`、`data-src / data-lazy-src / data-original /
  data-ks-lazyload / data-echo …`，以及**任意以图片扩展名结尾的 `data-*` 属性**（应对平台改属性名）；
  `<picture><source srcset>`；`background-image`（含 CSS 多背景层）；
  内联 `<script>` / `<style>` 文本中的图片地址（淘宝详情数据常以 JSON 内联，图片还没进 DOM）。
- **懒加载**：先按 85% 视口高度自动滚动到底再滚回原位，触发 `IntersectionObserver` 类懒加载。
- **平台差异兼容**：把缩略图地址还原成原图地址再下载——
  - 阿里：`abc.jpg_430x430q90.jpg` / `abc.jpg_.webp` → `abc.jpg`
  - 京东：`/n1/s450x450_jfs/...` → `/n0/jfs/...`
  - 拼多多：`abc_450x450.jpg`、`?imageMogr2/thumbnail/450x450` → 去掉尺寸后缀与处理参数
- **过滤**：`data:`/`blob:`、SVG、`/tps/` UI 切图、logo/icon/qrcode/watermark/埋点域名、
  1×1 像素图、短边 < 100px 的图片；尺寸未知的候选会并发联网探测真实尺寸（上限 400 张）。
- **去重**：以「主机名 + 路径」（丢弃查询串）为键，同一张图的不同尺寸变体只保留一条。
- 结果通过 `chrome.runtime.sendMessage({type:'EMI_IMAGES_FOUND'})` 交给 Service Worker。

### 3. 预览页

- 暗色「接触印相」风格，透明棋格底便于看 PNG 透明区；`auto-fill` 响应式网格。
- 每张卡片：缩略图、序号、尺寸、格式、复选框、原图链接、单张下载按钮、下载状态角标。
- 顶部：全选 / 反选 / 清空、最小尺寸筛选、文件名前缀、已选数量、下载、取消、重新获取、清除数据。
- 选择逻辑自接管，支持 Shift 区间连选；最小尺寸筛选会同步取消被隐藏图片的勾选，避免误下载。

### 4. 下载与 PNG 转换（background.js）

```
fetch(原图地址)                 // SW 中执行，凭 host_permissions 绕过页面 CORS
  → createImageBitmap(blob)     // 顺带纠正 CDN 的 application/octet-stream
  → OffscreenCanvas.drawImage   // 保留透明通道
  → convertToBlob('image/png')  // 统一输出 PNG（原图已是 PNG 则直接复用，无损）
  → chrome.downloads.download   // 文件名 商品图_001.png
```

- **大文件通道**：`data:` URL 长度上限约 2MB 字符，超限时 Service Worker 会把 PNG 的 base64
  交给预览页，由预览页 `URL.createObjectURL` 生成 blob URL 再下载（blob URL 无长度限制）。
- **降级策略**：某张图的 CDN 域名不在 `host_permissions` 内（fetch 被拒）时，自动改为
  **原始格式直链下载**，文件名扩展名同步变成 `.jpg/.webp/...`，并在卡片与结果报告里标注「原格式」。
- **进度**：每完成一张广播 `EMI_PROGRESS`，结束广播 `EMI_FINISHED`；进度同时落 `chrome.storage.local`，
  预览页关掉再打开也能恢复；批量下载期间用 20 秒心跳防止 Service Worker 被回收。
- 支持取消：已开始的任务会在当前图片处理完后停止。

---

## 五、自测

不需要打开浏览器即可运行全部测试（依赖 Node 18+，DOM 测试需要 `jsdom`）：

```bash
npm install        # 安装 jsdom（仅测试用）
npm test           # 依次跑下面 4 个脚本
```

| 脚本 | 覆盖内容 |
| --- | --- |
| `tests/validate-extension.js` | manifest 合法性、权限与域名、文件完整性、图标 PNG 头、MV3 CSP（无内联脚本）、脚本语法 |
| `tests/test-image-utils.js` | URL 补全/清洗、三平台原图还原、去重键、srcset 解析、背景图与内联文本抽取、过滤规则、文件名补零 |
| `tests/test-content-dom.js` | jsdom 模拟天猫详情页：按钮注入与定位、10 张图片全量采集、过滤 1x1/小图/logo、去重、相对路径补全、消息发送；登录页与非目标域名不注入；京东/拼多多详情页判定 |
| `tests/test-background.js` | 用 vm 模拟 SW 环境：会话落库与打开预览页、PNG 转换与命名、data URL 通道、大文件 blob 通道、fetch 失败降级原格式、重取/清空/错误提示 |

当前结果：**77 项断言全部通过**。

### 浏览器里的离线预览（不用装扩展）

`tools/` 下有两个自检页面，直接用浏览器打开（或起一个静态服务器，例如
`npx serve .`、`python -m http.server`）即可看到真实样式与交互：

| 页面 | 用途 |
| --- | --- |
| `tools/preview-button.html` | 用与 `content.js` 相同的方式（Shadow DOM + 构造样式表）渲染悬浮按钮，并铺一层模拟商品页背景，确认按钮不遮挡页面原有操作；改 `content.css` 后刷新即可看效果。 |
| `tools/preview-gallery.html` | 用桩数据渲染预览页：9 张示例图，勾选 / 全选 / 反选 / Shift 连选 / 最小尺寸筛选 / 快捷键都可用；点「下载选中」会**用假数据回放一遍下载流程**（逐张「转换中 → 已完成 / 原格式 / 失败」、顶部进度条、底部结果报告），不需要加载扩展。页面右上角标了「离线演示 · 下载为模拟」，别把这里的进度当成真实下载。 |

浏览器端的真机验证请按上面的「安装 / 使用」走一遍；建议重点看两处：
1. 按钮是否只在详情页出现，且不影响页面原有操作；
2. 下载结果目录里的文件是否为 PNG、命名是否为 `商品图_001.png` 起。

---

## 六、已知限制

- **GIF / 动态 WebP** 转 PNG 后只保留第一帧（canvas 特性）。
- 超大图（例如 8000×8000）转 PNG 会明显变大，且占用内存，建议用「最小尺寸」筛选后按需下载。
- 少数 CDN 对 `Referer` 有校验，或域名不在 `host_permissions` 内时，会走「原格式下载」分支
  （已在卡片与报告中标出）；把该图片域名补进 `manifest.json` 的 `host_permissions` 即可转 PNG。
- 平台改版（DOM 结构或图片属性名变化）可能影响判定，`content.js` 的 `DETAIL_SELECTORS`
  与通用 `data-*` 兜底逻辑已经尽量做了冗余；必要时调整 `CONFIG.MIN_WIDTH / MIN_HEIGHT`。
- 详情页里被「高度折叠、点击才展开」的图片（尚未进入 DOM）需要在点击前先展开一次。
