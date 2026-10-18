# 本地模型固定资产来源

模型目录的当前九个文件由 [modelCatalog.ts](../../apps/desktop/src/main/services/localModels/modelCatalog.ts) 与资产表维护；下载、导入和用途选择共用该身份，不从本页生成清单。操作与支持范围见[本地模型管理](../../website/src/content/docs/guide/local-models.md)。

## 固定上游身份

下列来源来自 2026-10-07 的发布元数据核查，Qwen 当前选用范围于 2026-10-10 收敛。大小与哈希以代码中的固定文件记录为准；上游 LFS 内容 SHA-256 不等于 Git blob 或仓库 commit。

| 模型与当前精度 | 固定 revision 与依据 |
| --- | --- |
| Kotoba Whisper v2.0，Q5_0／原始 GGML | [e3a0cf6a62b95911703cfb97d819292e058f12c3](https://huggingface.co/api/models/kotoba-tech/kotoba-whisper-v2.0-ggml/revision/e3a0cf6a62b95911703cfb97d819292e058f12c3?blobs=true) |
| bartowski Qwen3 1.7B，Q4_K_M／Q5_K_M／Q6_K | [dcb19155b962dbb6389f4691a982043a8e651022](https://huggingface.co/api/models/bartowski/Qwen_Qwen3-1.7B-GGUF/revision/dcb19155b962dbb6389f4691a982043a8e651022?blobs=true) |
| Qwen 官方 Qwen3 1.7B，Q8_0 | [90862c4b9d2787eaed51d12237eafdfe7c5f6077](https://huggingface.co/api/models/Qwen/Qwen3-1.7B-GGUF/revision/90862c4b9d2787eaed51d12237eafdfe7c5f6077?blobs=true) |
| 腾讯 HY-MT2 7B，Q4_K_M／Q6_K／Q8_0 | [独立模型与许可依据](hy-mt2-model-evidence.md) |

Kotoba 原始 GGML 的 F16 标签来自[发布者默认转换指令](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/blob/e3a0cf6a62b95911703cfb97d819292e058f12c3/README.md)，不是逐张量类型实测。bartowski 和 Qwen 官方的 Q8_0 文件名、大小和摘要不同，不能只按精度名称互换发布者。bartowski 模型卡的部分显示名与实际文件名不同，应使用文件 API 的真实 `rfilename`。

早期调查列出的其它精度不属于当前应用目录，已移除的 Index-Translate 也不构成支持或迁移承诺。模型资产元数据核查不证明翻译效果、峰值内存或任意设备可用性；真实推理按[历史验证记录](../archive/local-ai/implementation-and-validation-2026-10.md)中的模型、平台和日期分别理解。
