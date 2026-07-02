# Javdex

本地 JAV 媒体库桌面应用（**Javdex**）。基于 **Electron + React 18 + TypeScript + better-sqlite3**，
提供本地视频扫描导入、智能番号解析、插件化网络元数据刮削（首发 JavDB）、海报/头像本地化、
多维检索与分类浏览。软件本身不内置播放器，统一调用系统默认播放器播放。

## 技术架构

严格遵循 Electron 进程分离原则：

- **主进程 (`src/main`)**：Node.js 原生 API、SQLite 读写、文件系统遍历、网络请求（含代理）、调用外部播放器。
- **预加载脚本 (`src/preload`)**：通过 `contextBridge.exposeInMainWorld('api', ...)` 暴露基于 Promise 的安全 IPC 通道。
- **渲染进程 (`src/renderer`)**：纯 React 前端，**禁止**直接引入 Node.js / 数据库模块。
- **共享 (`src/shared`)**：跨进程复用的 TypeScript 类型与 IPC 通道常量。

### 目录结构

```
src/
  main/
    index.ts                 应用生命周期 + media:// 资产协议注册
    db/                      数据库初始化、Schema、各表 Repository
    settings/                设置持久化 (userData/settings.json)
    scanner/                 文件扫描 + 番号正则解析
    scrapers/                BaseScraper 接口 / JavDBScraper / 调度管理
    services/                资产下载本地化、批量刮削队列、外部播放器
    utils/                   axios + https-proxy-agent HTTP 客户端
    ipc/                     IPC 处理器注册中心
  preload/index.ts           contextBridge 安全桥
  renderer/                  React 前端（路由、页面、组件）
  shared/                    共享类型与 IPC 通道
```

### 资产存储

所有刮削到的海报、头像下载到 `app.getPath('userData')/media_assets/` 下的
`covers/` 与 `avatars/` 子目录。数据库中只存相对路径，渲染进程通过自定义
`media://` 协议安全读取。

## 数据库

启动时在主进程自动创建表：`videos`、`actresses`、`video_actress`、`tags`、`video_tag` 等（含相关索引）。数据库文件位于
`userData/data/library.db`（WAL 模式）。用户数据目录为 `%APPDATA%/Javdex`。

## 开发与运行

> 需要 Node.js 18+。`better-sqlite3` 为原生模块，安装后会自动针对 Electron 重新编译
> （`postinstall` 执行 `electron-rebuild`）。

```bash
npm install      # 安装依赖并重建原生模块
npm run dev      # 启动开发模式（热更新）
npm run build    # 生产构建
npm start        # 预览生产构建
```

## 核心功能

- **扫描导入**：递归扫描 `.mp4/.mkv/.avi/.wmv` 等，正则过滤干扰字符提取标准番号，按番号/路径去重入库。
- **插件化刮削**：实现 `BaseScraper` 接口，首发 `JavDBScraper`；支持 HTTPS 代理。
- **批量刮削队列**：顺序处理未刮削影片，每个番号间随机等待 3~5 秒，实时回传进度与日志。
- **演员归并**：刮削演员时同时比对 `main_name` 与别名表，命中别名则归入对应主演员。
- **外部播放**：`shell.openPath` 唤起系统播放器，并累加播放次数 / 更新最近播放时间。
- **虚拟滚动**：海报墙基于 `react-window` 窗口化渲染，万级影片滚动流畅。
- **容错**：播放时文件缺失会弹出优雅提示，可一键从数据库移除。

## 设置页

- 媒体库路径管理与扫描；
- HTTP/HTTPS 代理地址（如 `http://127.0.0.1:7890`）；
- 一键批量刮削，含进度条与实时日志。
