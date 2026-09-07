# Javdex 官网

以方案 C 为基础的优化版，源码是本目录的 `index.html`、`styles.css`、`app.js`。旧提案与临时预览产物已清理。

## 构建与预览

```sh
node website/scripts/build.mjs
npx vite dist-pages --host 127.0.0.1 --port 4319 --strictPort
```

构建时读取 GitHub 最新正式 Release，生成六个安装包的直接下载地址、文件名和大小。版本来自实际 Release，不跟随尚未发布的 package.json 版本。CI 中缺失安装包会使构建失败；本地网络异常使用 Release 页面兜底。可用 `--offline` 显式离线构建。

## 产品截图

页面全部使用当前应用真实渲染的截图，演示数据是虚构的。保留横版封面原图，媒体库和清单按软件的竖版卡片模式，从右侧裁切为 7:10；没有使用重新生成的竖版海报。详情页沿用软件本来的横向封面区域，背景来自独立场景图。截图没有替换或重绘软件控件。

```sh
npm run build
node website/scripts/capture.mjs
python website/scripts/optimize-assets.py
node website/scripts/build.mjs
```

截图脚本仅启动 `output/playwright/website-product-profile` 专用 Electron 配置目录，通过 `JAVDEX_TEST_USER_DATA` 隔离，不读取或修改正常用户资料库。真实创建向导包含基本信息、根目录、扫描配置、首次扫描四步；网页随后说明刮削来源配置和浏览整理。当前向导截图演示跳过目录创建空库，文案明确说明立即扫描不可用。

更新根目录 README 的两张配图：运行 `node website/scripts/capture.mjs --readme`，随后运行 `python website/scripts/optimize-assets.py --readme`。此模式写入 `docs/images/`，展示浅色媒体库和深色影片详情，不覆盖官网截图。

功能依据：`MediaLibraryCreateModal.tsx`、`VirtualPosterGrid.tsx`、`coverAspect.ts`、`DetailPage.tsx`、`NfoExportPanel.tsx`、`PluginsSettingsPanel.tsx`，以及根目录 README、`docs/NFO_COMPATIBILITY.md`。NFO 导入软件名单表示固定版本样本验证，不宣称支持其所有历史版本。

## 素材

- 品牌图标由 `build/icon-1024.png` 缩小为 256px PNG，保留透明通道与高分屏清晰度。
- 界面装饰图标使用 Lucide，保留 `assets/LUCIDE-LICENSE.txt`。
- 影片封面和背景由内置 imagegen 生成；主题与提示词说明见 `assets/artwork/README.md`。
- 网站构建仅复制最终软件截图，不打包用于生成截图的原始大图。

`optimize-assets.py` 需要 Pillow（`python -m pip install Pillow`）。封面和背景使用质量 88 的 WebP，保留原尺寸、横向构图；界面截图使用无损 WebP，并逐像素验证转换结果，避免损伤文字。转换成功后删除对应 PNG，避免重复保留。重新截图后运行压缩脚本，再构建网站。

网站只有本地预览，构建或截图不会触发线上发布。
