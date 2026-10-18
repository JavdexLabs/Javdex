# Windows Whisper Vulkan 按需分发

Windows x64 的可选 Whisper Vulkan 运行库由独立的 `JavdexLabs/javdex-runtime` 构建发布，Javdex 固定消费已公开的发行，不再在主安装包内携带。引擎仍为原 b5130 提交，模型权重、用途、计算设备与 CPU 回退策略不变。

## 已公开运行库

2026-10-18 10:32:09（Asia/Shanghai）公开 [whisper-b5130-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/whisper-b5130-r1)，Release `416191626` 已确认 `immutable=true`。标签及原生产物来源为 `21bef11113cff0544cdc615fa93767994f4d9cde`，完整 [原生 CI 39089754724](https://github.com/JavdexLabs/javdex-runtime/actions/runs/39089754724) 的合同、Windows 构建、CLI、固定 Kotoba/VAD CPU 烟测、ZIP 往返及 Draft 准备均成功。实际 GPU 推理记录为 `not-tested`，不是通过。

固定 ZIP `whisper-b5130-r1-win32-x64-vulkan.zip` 为 18,095,994 字节，SHA-256 为 `4ebbd89cd9ce82685482b7c63be1ebeb13f5d91ee1e46c451f76bc809b36bfc5`，展开上限 58,161,361 字节。以上来自同次 CI 的发行清单及 GitHub 附件身份；消费方没有额外下载公开 ZIP 做独立产物验收。运行库不包含模型、驱动或开发 SDK，各第三方许可和来源随包保留。

首轮被主动取消的构建不计通过。随后 `39089096624` 的编译及模型加载成功，但 CPU 烟测达到 180 秒限时；新源码仅将最多三秒的测试音频限定为 256 个编码上下文位置，生产编译选项未改变，完整新 CI 已成功。发布工具另修正 GitHub 未建标签 Draft 的检索与字符串 HTTP 状态处理；这些维护工具修正没有重建或更换上述固定产物。

## Javdex 消费和替换边界

`gpuManifest.ts` 固定上述 URL、大小、摘要和来源。安装沿用现有有界下载、续传、暂存和原子晋升，增加平铺包格式、目标、接口、来源、精确文件集合及逐文件摘要校验。有效旧 b5130 Windows Vulkan 安装继续使用原来源身份，不因分发方式变化无条件重下；损坏的安装不被认作可用，下载或安装失败保留旧文件。macOS 工具分发、其他后端和用户设置保持原行为。

维护者明确授权将原始 0.9.0 的整套安装包、源码、升级包、镜像和标签一起重建替换，具体一次性约束见 [发布规范第 11 节](../VERSIONING_AND_RELEASE.md#11-原始-090-的一次性整套替换)。普通发布禁止覆盖的规则仍然有效。替换必须等待本轮正常 PR 和完整 Release 门禁；原 Release、十个附件字节、标签和镜像索引保留可恢复副本，不能混用旧产物或先删除公开资产再等待长构建。

本轮不执行独立公开软件产物验收，不能记为通过。Windows ZIP 实际安装回归以本轮原生 Windows 测试为准，macOS 上的跳过不替代 Windows 结论。

## 0.9.0 整套重建发布

2026-10-18 13:35:46（Asia/Shanghai）公开新的 [Javdex v0.9.0](https://github.com/JavdexLabs/Javdex/releases/tag/v0.9.0)，Release ID 为 `416257668`。完整 [Release CI 39097548024](https://github.com/JavdexLabs/Javdex/actions/runs/39097548024) 只手动启动一次，实际构建、签名、标签和发布源码均固定为 `9d48f4fe80df614137a3b67480309aa17e3e6161`；十个附件均来自这次重建。逐项 GitHub 元数据、CI 作业及归档身份见 [发布记录](whisper-vulkan-runtime-release-evidence.json)。

前置 PR CI `39096682777` 的桌面完整测试为 4196 项，4174 通过、0 失败、22 项平台跳过；随后 HTTPS 桌面运行时重启、Docker Agent 和五组备份恢复烟测实际成功。Release 的 Windows 完整 Electron 测试分两批执行，共 4196 项，4170 通过、0 失败、26 项平台跳过；另有 8 项原生 Windows 播放授权回归通过。新的平铺 ZIP 安装、续传、复用和失败保留旧工具测试在 Windows 实际通过，不再沿用 macOS 跳过的结论。PR 的 Bugbot 因额度上限返回 neutral，未执行审查，不能计为通过。

本轮四平台原生打包、最终安装包内播放验证、总播放源码往返、macOS 签名、双架构服务端容器、镜像合成及发布共 11 个作业全部成功。amd64 与 arm64 的 Linux root 附加组专项各为 1 通过、0 失败、0 跳过；真实单容器签名更新、失败和中断维护、镜像升级、同版及旧 seed 保留、HTTPS 配对与设备撤销和容器烟测也均成功。这些 CI 结果不代表物理 GPU、跨平台 GUI 或干净机器安装验收。

固定镜像 `ghcr.io/javdexlabs/javdex-server:0.9.0` 的索引为 `sha256:729b05138f9ddd617e8cd40efe619875a8bea9001d273e09e3736767ee862ccc`，与同轮暂存镜像及发布回执一致。GitHub 附件元数据显示 Windows ZIP 从原来的 207,445,067 字节变为 190,652,923 字节；这里没有另行下载公开 ZIP 验证字节。

原 Release `416016386` 保留为归档 Draft，十个原附件的 ID、大小和 GitHub 摘要均未改变。归档标签 `archive/0.9.0/original-bb843322112d536380ec7587c8569cc80680e733` 保留原源码；镜像标签 `archive-0.9.0-bb843322112d536380ec7587c8569cc80680e733` 保留原索引 `sha256:d2cb482d5d3f981fd55a8c871f6f5a5d53fefa9cfd46d1605c75ff4736149693`。CI 回执 `Controlled-090-Replacement-Receipt` 记录完整暂存、原身份复核、归档、标签与镜像切换及新发布完成，未发生恢复。此次单次覆盖授权已经使用，不再重复覆盖新的公开 0.9.0；0.8.0 和历史 Beta 固定资产未纳入替换。

以上发布身份通过 GitHub 元数据和匿名 registry HEAD 核对，没有下载公开安装包、校验和、源码、升级包或镜像做独立产物验收。PR #121 的正常合入与对应新 main Pages 部署仍待后续完成；本次文档提交不重新构建或发布软件。
