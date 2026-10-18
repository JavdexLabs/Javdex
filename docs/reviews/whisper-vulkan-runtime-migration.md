# Windows Whisper Vulkan 按需分发

Windows x64 的可选 Whisper Vulkan 运行库由独立的 `JavdexLabs/javdex-runtime` 构建发布，Javdex 固定消费已公开的发行，不再在主安装包内携带。引擎仍为原 b5130 提交，模型权重、用途、计算设备与 CPU 回退策略不变。

## 已公开运行库

2026-10-18 10:32:09（Asia/Shanghai）公开 [whisper-b5130-r1](https://github.com/JavdexLabs/javdex-runtime/releases/tag/whisper-b5130-r1)，Release `416191626` 已确认 `immutable=true`。标签及原生产物来源为 `21bef11113cff0544cdc615fa93767994f4d9cde`，完整 [原生 CI 39089754724](https://github.com/JavdexLabs/javdex-runtime/actions/runs/39089754724) 的合同、Windows 构建、CLI、固定 Kotoba/VAD CPU 烟测、ZIP 往返及 Draft 准备均成功。实际 GPU 推理记录为 `not-tested`，不是通过。

固定 ZIP `whisper-b5130-r1-win32-x64-vulkan.zip` 为 18,095,994 字节，SHA-256 为 `4ebbd89cd9ce82685482b7c63be1ebeb13f5d91ee1e46c451f76bc809b36bfc5`，展开上限 58,161,361 字节。以上来自同次 CI 的发行清单及 GitHub 附件身份；消费方没有额外下载公开 ZIP 做独立产物验收。运行库不包含模型、驱动或开发 SDK，各第三方许可和来源随包保留。

首轮被主动取消的构建不计通过。随后 `39089096624` 的编译及模型加载成功，但 CPU 烟测达到 180 秒限时；新源码仅将最多三秒的测试音频限定为 256 个编码上下文位置，生产编译选项未改变，完整新 CI 已成功。发布工具另修正 GitHub 未建标签 Draft 的检索与字符串 HTTP 状态处理；这些维护工具修正没有重建或更换上述固定产物。

## Javdex 消费和替换边界

`gpuManifest.ts` 固定上述 URL、大小、摘要和来源。安装沿用现有有界下载、续传、暂存和原子晋升，增加平铺包格式、目标、接口、来源、精确文件集合及逐文件摘要校验。有效旧 b5130 Windows Vulkan 安装继续使用原来源身份，不因分发方式变化无条件重下；损坏的安装不被认作可用，下载或安装失败保留旧文件。macOS 工具分发、其他后端和用户设置保持原行为。

维护者明确授权将原始 0.9.0 的整套安装包、源码、升级包、镜像和标签一起重建替换，具体一次性约束见 [发布规范第 11 节](../VERSIONING_AND_RELEASE.md#11-原始-090-的一次性整套替换)。普通发布禁止覆盖的规则仍然有效。替换必须等待本轮正常 PR 和完整 Release 门禁；原 Release、十个附件字节、标签和镜像索引保留可恢复副本，不能混用旧产物或先删除公开资产再等待长构建。

本轮不执行独立公开软件产物验收，不能记为通过。Windows ZIP 实际安装回归在原生 Windows 测试运行；macOS 上的该项跳过不替代 Windows 结论。最终 Javdex Release、main 与 Pages 的完成状态以各自后续实际记录为准；此运行库发行本身不表示应用整套替换已完成。
