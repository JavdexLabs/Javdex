# Javdex

本地 JAV 媒体库桌面应用（**Javdex**）。基于 **Electron + React 18 + TypeScript + better-sqlite3**，
提供本地视频扫描导入、智能番号解析、插件化网络元数据刮削、海报/样张/写真本地化、
多维检索与分类浏览。软件本身不内置播放器，统一调用系统默认播放器播放。

## 技术架构

严格遵循 Electron 进程分离原则：

- **主进程 (`src/main`)**：Node.js 原生 API、SQLite 读写、文件系统遍历、网络请求（含代理）、刮削浏览器会话、调用外部播放器。
- **预加载脚本 (`src/preload`)**：通过 `contextBridge` 暴露基于 Promise 的安全 IPC 通道。
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
    scrapers/                插件刮削运行时、浏览器会话、挑战处理
    bundled-plugins/         内置刮削插件（JavDB、JavLibrary、JAV8 等）
    services/                资产下载、批量刮削队列、LLM、外部播放器
    ipc/                     IPC 处理器注册中心
  preload/index.ts           contextBridge 安全桥
  renderer/                  React 前端（路由、页面、组件）
  shared/                    共享类型与 IPC 通道
  mcp/                       插件开发 MCP 服务（可选）
```

### 资产存储

刮削到的封面、样张、演员头像/写真等下载到 `app.getPath('userData')/media_assets/`（路径可在设置中迁移）。
数据库中只存相对路径，渲染进程通过自定义 `media://` 协议安全读取。

## 数据库

启动时在主进程自动创建表（schema version **1**），主要表包括：

- `videos` / `video_files`：影片元数据与多文件关联
- `actresses` / `actress_names` / `actress_gallery_assets`：演员与写真
- `tags` / `video_tag`、`playlists` / `playlist_video`
- `facet_entries`：片商/发行/系列/导演等维度注册表
- `video_assets`：样张等媒体资产
- `video_external_ids` / `video_external_stats`：外部站点 ID 与评分

数据库文件位于 `userData/data/library.db`（WAL 模式）。用户数据目录默认为 `%APPDATA%/Javdex`。

> 开发期若使用过旧 schema 版本的数据库，启动会提示删除 `library.db`（及 `-wal`、`-shm`）后重建。

## 开发与运行

> 需要 Node.js 18+。`better-sqlite3` 为原生模块，安装后会自动针对 Electron 重新编译
> （`postinstall` 执行 `electron-rebuild`）。

```bash
npm install      # 安装依赖并重建原生模块
npm run dev      # 启动开发模式（热更新）
npm run build    # 生产构建
npm start        # 预览生产构建
npm test         # 类型检查 + 单元测试
npm run dist     # 打包安装程序（见 scripts/dist.mjs）
```

## 核心功能

- **扫描导入**：递归扫描常见视频格式，正则提取番号，支持同番号多文件入库。
- **插件化刮削**：内置 JavDB、JavLibrary、JAV8 等视频插件及演员插件；支持用户自定义插件与插件开发助手。
- **批量刮削**：顺序队列、随机间隔、实时进度与日志；支持空字段补齐 / 有值覆盖 / 覆盖更新。
- **演员归并**：刮削演员时比对主名与别名，命中别名归入对应主演员。
- **清单与分类**：播放清单、片商/发行/系列/导演/标签等多维浏览。
- **样张与写真**：本地文件或图片链接导入，远程图片经主进程拉取预览。
- **LLM 集成**：可配置多家模型提供商，用于元数据翻译等辅助能力。
- **网络与代理**：HTTP/HTTPS 代理、连接测试；刮削与远程图片下载共用代理设置。
- **外部播放**：唤起系统默认播放器；文件缺失时可从库中移除。
- **虚拟滚动**：海报墙基于 `react-window` 窗口化渲染。

## 设置页

- 媒体库路径管理与扫描
- 资产存储位置与迁移
- HTTP/HTTPS 代理与连接测试
- 刮削插件管理与配置
- LLM 提供商与模型
- 批量刮削与维护工具

## 文档

- `docs/UI_DESIGN_GUIDELINES.md` — UI 设计规范
- `docs/SCRAPER_PLUGIN_FORMAT.md` — 刮削插件格式
- `docs/PLUGIN_DEV_AGENT.md` — 插件开发助手
- `CHANGELOG.md` — 版本变更记录

## 规划中的功能

见 `todo.md`（内置播放器、NFO 导入导出、更多主题等）。
