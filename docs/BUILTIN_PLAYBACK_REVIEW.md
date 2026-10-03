# 内置播放提交前审查

日期：2026-10-03。范围：`codex/libmpv-native-render-prototype` 上自 `93127dc` 起的全部未提交改动，包含原生 adapter、桌面会话与 UI、共享返回协调、GPL 声明及构建／验收脚本。基线之后没有既有提交，因此新文件与 tracked diff 一起审查，而非仅检查三点 diff。

按 `code-review` 技能并行检查仓库规范和实施方案；复核后修复本轮发现。历史协调采用 `codebase-design` 的集中所有权原则：复杂性留在共享协调器，不增加每个页面各自的返回栈。用户授权提交和推送此功能分支，不包含合并、发布或将整个实施计划标为完成。

## Standards

**发现 2 项，均为 P2，均已修复。** 依据 [路由规范](ROUTING_DESIGN.md) 和 [图片预览历史合同](IMAGE_PREVIEW_HISTORY_DESIGN.md)。没有额外编码气味项升级为规范缺陷。

1. 关闭 overlay 的异步 POP 会把 React Router blocker 重置；随后调用旧 blocker 的 `proceed()` 可能抛出无效状态迁移并丢失业务导航。修复为共享协调器保存业务 intent，读取 router 当前 blocker 后决定继续或重放，保持 PUSH／REPLACE／POP、目标 state、历史游标和已确认草稿的语义。回归使用真实 `createHashRouter`，分别模拟游标移动和事件交付，也覆盖取消、卸载、重复确认及新的目标取代旧目标。
2. fallback 已消费旧 POP 并推入新预览时，迟到的旧事件仍会关闭新预览。修复为先核对事件 marker 与实时游标 marker，旧事件不能确认当前 traversal 或关闭新的 token；增加分离游标与事件的回归。

## Spec

**发现 2 项，均为 P2，均已修复。** 依据 [实施方案](BUILTIN_PLAYBACK_DESIGN_PROPOSAL.md) 的来源选择、显式外部打开及缺失／离线分类要求。

1. 已扫描文件被移走，但授权根目录仍有效时，错误被统一映射成根目录不可用。文件检查现在只在根目录已授权、路径位于授权根内且根身份仍有效时抛出受控的 missing 类型；离线、换根、禁用和越界仍拒绝。resolve／validate 每次新建检查器，不把扫描计划的缓存沿用至整个播放会话。保留原有对调用方的通用消息和 canonical／symlink 检查。
2. 正常播放选项缺少来源选择和外部打开。复用现有 scoped detail／资源打开接口，仅投影当前媒体库与影片的本地文件 ID 和展示名，不创建另一套来源合同。显式切换保留本次进度记录选择，不修改主资源；外部打开成功后只停止原会话，失败保留当前播放，旧请求不能停止替换会话。查询迟到和重复提交有回归覆盖。

## 补充工程检查

- Windows addon 原构建缺少 Electron 延迟加载钩子。直接编入已安装 node-gyp 的钩子，设置 HOST_BINARY、`/DELAYLOAD:node.exe` 和 delayimp；缺少输入时构建失败。保留上游 MIT 文本和第三方声明。依据 [Electron 原生模块合同](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules#a-note-about-win_delay_load_hook)；本机命令／配置测试不是 Windows 编译或加载证据。
- Linux 全屏隐藏控件后的首击重新按控制栏位置分派，不误当作视频暂停；增加边界和缩放几何断言。Xlib error trap 的活动对象改为线程局部，跨线程只使用稳定的原 handler，不访问已释放的栈对象。没有 Linux GUI 或并发故障注入验收证据。
- 普通打包继续排除本机开发 addon、合成素材和临时 bundle；GPL／历史 MIT／第三方声明进入既有桌面及 server 产物合同，不把系统开发库当作已审核分发库。

## 本轮验证与边界

提交前各次执行分别记录，不把此前媒体检查当作本轮重跑：

- 新增播放面 8 项回归、来源／文件检查及已有 IPC 路径保护 19 项、历史／离开保护 28 项定向回归通过；Windows 构建命令／配置测试 5 项通过。后续全量结果另列。
- 修复后的 `npm test` 正常退出 0：pretest 的全量 TypeScript／CSS lint、架构／workspace／UI 合同检查，以及类型、打包、fixture、构建计划均通过；Electron 测试 3517 项、3515 通过、2 个 Windows 路径语义用例跳过、0 失败。宿主打包测试另有 Linux ELF-only fixture 跳过，已在两种 Linux 开发镜像独立执行，不把本机跳过算作通过。
- macOS 原生构建、桌面重建通过；真实应用 `playback-acceptance.mjs` 正常退出，包含新来源查询与正常播放外部入口、基本播放／字幕／续播／错误与分层返回。`playback-close-acceptance.mjs` 重新确认活跃播放时主窗口实际销毁、退出前内核释放。两次应用检查均 forced=false、code=0；没有用独立探针或强制销毁冒充通过。来源切换的并发／会话边界由组件回归覆盖；本轮未实际启动外部播放器。
- server build 和生产闭包检查通过。`server:test` 合计 53 项、47 通过、6 跳过、0 失败：跳过真实 mount、需要显式开启的 mpv 场景及 Linux-only 故障／网络隔离项，未算作通过。没有运行本机根 Dockerfile 的 Cloud 专属 server smoke。
- Linux 当前源码以 Debian bookworm 开发依赖分别在 arm64、模拟 x64 编译；核心／控制 C++ 回归、无 DISPLAY 的 Node addon 加载及句柄／空会话检查通过。两边运行库测试各 6 通过、1 macOS-only 跳过，真实 ELF fixture 搬移加载通过；缺少 libmpv 分发闭包的开发 addon 正确拒绝。开发镜像 ID：arm64 `1d13fa79c7a3`、x64 `9d84638e5e9e`，没有推送。未创建 GL context、未播放或检查 Linux GUI。

生成日志、合成素材和应用截图保留在被忽略的 `out/`，不提交安装包或开发镜像。没有修改个人媒体库，既有用户进程不作为回归宿主。既有 `BUILTIN_PLAYBACK_RESEARCH.md` 的历史研究保持原文，不据实施结果追溯改写。

仍未完成：Windows 实际编译和 PE 检查；Windows／Linux 实机可见播放、输入与无障碍；macOS 完整人工音画、长片、VoiceOver、设备手势和跨屏；三平台可迁移运行库的实际来源／许可、签名及干净安装。原生 Wayland 按确认后置。上述待验收项不由单元测试、编译、FBO 读回或许可声明自动通过；三平台共同发布要求不变。
