# HY-MT2 7B 模型与许可依据

本文保留当前接入所依据的固定上游许可、模型身份和模板证据，不再保留已落地的接入阶段或未采用的 1.8B／30B／特殊低比特方案。当前用途、配置与设备行为见 [AI 字幕与本地推理](../AI_SUBTITLES_IMPLEMENTATION.md)。

## 来源与许可

2026-10-07 核查的腾讯官方 7B 仓库使用 Apache License 2.0，实际许可全文见[原始模型](https://huggingface.co/tencent/Hy-MT2-7B/blob/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223/LICENSE.txt)、[FP8](https://huggingface.co/tencent/Hy-MT2-7B-FP8/blob/883d09eb21d9be92058556cd0a4016d8a648c7db/LICENSE.txt)与[GGUF](https://huggingface.co/tencent/Hy-MT2-7B-GGUF/blob/ab8472660ac61fac25f1af43fac2599d52a8a775/LICENSE.txt)。这是实际文件依据，不是仅凭模型卡标签；不能套用前代 Hunyuan-MT 或 Chimera 的社区许可。

当前下载固定于 `tencent/Hy-MT2-7B-GGUF@ab8472660ac61fac25f1af43fac2599d52a8a775`。三份独立文件的真实大小写为：

| 精度 | 官方文件名 | 字节 |
| --- | --- | ---: |
| Q4_K_M | `Hy-MT2-7B-Q4_K_M.gguf` | 4624648896 |
| Q6_K | `HY-MT2-7B-Q6_K.gguf` | 6164482720 |
| Q8_0 | `HY-MT2-7B-Q8_0.gguf` | 7981928896 |

文件身份来自[固定文件 API](https://huggingface.co/api/models/tencent/Hy-MT2-7B-GGUF/revision/ab8472660ac61fac25f1af43fac2599d52a8a775?blobs=true)；下载与导入仍按代码记录校验大小及 SHA-256。磁盘字节数不是最低 RAM／VRAM 要求。

## 模板与终止 token

7B 的[固定模板](https://huggingface.co/tencent/Hy-MT2-7B/blob/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223/chat_template.jinja)使用 `<|startoftext|>`、`<|extra_0|>` 和 `<|eos|>`，不能借用 1.8B 或千问的模板。原始[生成配置](https://huggingface.co/tencent/Hy-MT2-7B/blob/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223/generation_config.json)与[tokenizer 配置](https://huggingface.co/tencent/Hy-MT2-7B/blob/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223/tokenizer_config.json)将两个终止 ID 定义为 127960／127967，对应 `<|eos|>`／`<|extra_5|>`。

接入时读取的三份 GGUF 有限前缀均为 `hunyuan-dense`、354 个张量，EOS=3、EOT=127960；Q4 的 token 3 为美元符号。固定 llama.cpp b11435 通过 `--override-kv` 恢复原始 EOS／EOT，并设置相应停止词，不改写模型文件。参数解析与词表依据分别见[固定解析器](https://github.com/ggml-org/llama.cpp/blob/b11435/common/arg.cpp)和[固定词表](https://github.com/ggml-org/llama.cpp/blob/b11435/src/llama-vocab.cpp)。Q6／Q8 的前缀核查未发现 STQ 类型，不能将特殊低比特说明套给普通量化。

模型卡推荐的 `top_p=0.6` 与原始生成配置的 0.8 有差异；应用使用独立模型策略，不声称二者是同一默认值。上述是当时静态来源核查，不是完整权重哈希重算或效果评测。后续 Windows GPU 短推理等实际范围见[验证历史](../archive/local-ai/implementation-and-validation-2026-10.md)，不以某一短句推理推出整片质量或通用性能。
