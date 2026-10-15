# assets 目录

官网目前**不使用任何外部图片**：Logo、图标是 `index.html` 里的内联 SVG 雪碧图，
插件界面示意图（浏览器窗口、商品图、悬浮按钮、预览条）全部由 `css/style.css` 用
CSS 渐变和棋格底绘制。这样做的好处是双击 `index.html` 就能打开，不依赖网络。

这个目录留给后续要放的真实素材：

| 文件名 | 用途 | 在页面里替换的位置 |
| --- | --- | --- |
| `screenshot-detail.png` | 商品详情页上的悬浮按钮实拍图 | `index.html` 中 `.mock__window` 整块 |
| `screenshot-gallery.png` | 预览页网格实拍图 | `index.html` 中 `.mock__sheet` |
| `image-grab.zip` | 打包好的插件压缩包 | 「下载插件」按钮的 `href`（见下） |

替换示意图时的建议：把 `.mock__window` 换成
`<img src="assets/screenshot-detail.png" alt="商品详情页右下角的获取图片按钮" width="1600" height="1000">`，
并保留外层的 `.mock` 容器（虚线圆角与阴影由它提供）。

替换下载链接：`index.html` 里有两个按钮指向插件压缩包，把 `href` 从 `#install`
改成实际地址即可（本地包写 `assets/image-grab.zip`，线上包写 Release 直链）：

```html
<!-- 底部 CTA -->
<a class="btn btn--primary btn--lg" href="assets/image-grab.zip" download>
```
