# Hy-MT2 可选本地翻译：有限可行性调研

调研日期：2026-10-07。查阅官方 Tencent-Hunyuan/Hy-MT2 GitHub、tencent Hugging Face 模型文件和公开 API，并对照 ggml-org/llama.cpp 固定版本源码与 Javdex 当时实现。调研阶段已读本仓库 AGENTS.md，未安装依赖、下载权重、登录或接受访问条款、运行推理、修改实现、提交或推送；后续接入工作另记于下文。

本文正文是接入前的调研快照；之后用户选择实际接入 **HY-MT2 7B**，而非下文建议的 1.8B 起点。当前实施范围与验证边界见 [实施记录](AI_SUBTITLES_IMPLEMENTATION.md#hy-mt2-7b-可选翻译模型2026-10-07)。后续仅读取普通 7B GGUF 的有限前缀核对元数据，未下载完整权重或进行本机推理。

[api-a]: https://huggingface.co/api/models/tencent/Hy-MT2-1.8B-GGUF/revision/a0c709d9fac510f2c807aa3af52872340dc37a4a?blobs=true
[api-b]: https://huggingface.co/api/models/tencent/Hy-MT2-7B-GGUF/revision/ab8472660ac61fac25f1af43fac2599d52a8a775?blobs=true
[api-c]: https://huggingface.co/api/models/tencent/Hy-MT2-30B-A3B-GGUF/revision/fd3dcbb6b31e9e03923ef4f9f42500f74c3851c3?blobs=true
[api-d]: https://huggingface.co/api/models/tencent/Hy-MT2-1.8B-1.25Bit-GGUF/revision/9df5c824a00a744fb0512a29c640466f4d97dfb0?blobs=true
[api-e]: https://huggingface.co/api/models/tencent/Hy-MT2-1.8B-2Bit-GGUF/revision/b630487d19ab7f336664a15b07c638d0d1071471?blobs=true

## 可行性判断

建议作为可选本地翻译模型，先走 **1.8B 标准 Q4_K_M / Q6_K / Q8_0 + 复用 llama.cpp** 的路线。优先试验 Q6_K（1,474,785,120 B），Q4_K_M 提供较小下载选项，Q8_0 作量化对照；7B 可作为后续可选质量对照。此为基于发布资产的实施建议，尚未证明 Javdex 已可加载或日语→中文字幕/资料翻译质量合格。[1.8B 资产][api-a]、[7B 资产][api-b]；官方支持语种表列有日语与中文：[官方 README](https://github.com/Tencent-Hunyuan/Hy-MT2/blob/ff1903ecaa724e10951a23c16817a2413c752b35/README.md#supported-languages)。

30B-A3B 的官方 Q4_K_M 文件已有 18,236,702,880 B，暂不建议作为端侧起点；MoE 的 A3B 命名不能当作磁盘或内存只需 3B 的承诺。[30B 资产][api-c]、[官方模型介绍](https://github.com/Tencent-Hunyuan/Hy-MT2/blob/ff1903ecaa724e10951a23c16817a2413c752b35/README.md#model-introduction)。

## Javdex 接入范围与代码边界

- **翻译而非识别**：作为千问之外的可选字幕/资料翻译模型，不替代 Kotoba 音频识别；说话人区分、识别标点增强仍属于独立的 Kotoba 2.2 接入范围。当前只有可行性结论，不变更默认模型。
- **复用既有运行库**：`runtimeManifest.ts` 固定 llama.cpp `b11435`。该版本转换器已注册 `HunYuanDenseV1ForCausalLM` → `HUNYUAN_DENSE`，模型 loader 和图中存在 Q/K norm 支持；官方普通 GGUF API 的架构为 `hunyuan-dense`。这提供接入依据，不能代替实际文件加载和生成验收。[固定转换器](https://github.com/ggml-org/llama.cpp/blob/b11435/conversion/hunyuan.py)、[固定模型定义](https://github.com/ggml-org/llama.cpp/blob/b11435/src/models/models.h)、[固定计算图](https://github.com/ggml-org/llama.cpp/blob/b11435/src/models/hunyuan-vl.cpp)、[官方 GGUF 元数据][api-a]。
- **模型身份必须解耦**：当前 `packages/contracts/src/desktop/localModels.ts` 仅有 `kotoba` / `qwen3`，`modelCatalog.ts` 把非 `kotoba-tech/` 发布者都归为千问，`localModelManager.ts` 把本地翻译选择和运行库租约固定绑定 `qwen3`。新增下载地址不够；需要显式模型家族/版本注册，以及独立的活动翻译模型选择。下载、校验、精度切换、删除、导出、目录迁移可以复用已有模型管理，不另起一套服务。
- **独立翻译 profile**：`offlineInference.ts` 当前使用 Qwen 的提示词和 `enable_thinking=false`。官方 Hy 1.8B 模板使用专属 HY token，没有这个开关分支；应让 llama-server 使用经过验证的官方 GGUF 模板/Jinja 路径，并分别配置提示、采样、输出处理。切换家族、精度或提示版本应隔离中文翻译缓存，保留未受影响的日语识别缓存。[官方固定模板](https://huggingface.co/tencent/Hy-MT2-1.8B/blob/9a341cd1b679d3efd23b46e847b01745a71ed792/chat_template.jinja)、[GGUF 内嵌模板][api-a]。本文未决定最终采样值，来源差异见下文。
- **不扩大平台承诺**：当前 Javdex AI 本地推理运行库支持 Windows x64；macOS/Linux 的模型下载与管理不等于推理已支持。新增 HY 模型不会自动补齐跨平台运行库。
- **特殊低比特不是直接可用**：固定 `b11435` 的类型枚举有 `TQ1_0` / `TQ2_0`，没有 STQ；查阅时 STQ 的 PR #22836 尚未合并。因此不将 1.25Bit 加入“已兼容”目录，2Bit 同样保留独立验证边界。PR 状态与文件类型须在实际实施时复核。[固定类型定义](https://github.com/ggml-org/llama.cpp/blob/b11435/ggml/include/ggml.h)、[STQ PR](https://github.com/ggml-org/llama.cpp/pull/22836)。

## 实际许可与访问状态

逐份读取下列 11 个仓库的实际 LICENSE，Hy-MT2 三个家族及官方 FP8/GGUF 衍生均明确为 Apache License, Version 2.0，许可正文一致；不是仅凭模型卡标签判断。

| 家族 | 当前实际许可 | 固定 revision 的 LICENSE |
| --- | --- | --- |
| 1.8B | Apache License, Version 2.0 | [原始](https://huggingface.co/tencent/Hy-MT2-1.8B/blob/9a341cd1b679d3efd23b46e847b01745a71ed792/LICENSE.txt)、[FP8](https://huggingface.co/tencent/Hy-MT2-1.8B-FP8/blob/b3f6f590920726d69a5504293bd4f36d50e5f681/LICENSE.txt)、[GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/blob/a0c709d9fac510f2c807aa3af52872340dc37a4a/LICENSE.txt)、[1.25Bit](https://huggingface.co/tencent/Hy-MT2-1.8B-1.25Bit-GGUF/blob/9df5c824a00a744fb0512a29c640466f4d97dfb0/LICENSE.txt)、[2Bit](https://huggingface.co/tencent/Hy-MT2-1.8B-2Bit-GGUF/blob/b630487d19ab7f336664a15b07c638d0d1071471/LICENSE.txt) |
| 7B | Apache License, Version 2.0 | [原始](https://huggingface.co/tencent/Hy-MT2-7B/blob/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223/LICENSE.txt)、[FP8](https://huggingface.co/tencent/Hy-MT2-7B-FP8/blob/883d09eb21d9be92058556cd0a4016d8a648c7db/LICENSE.txt)、[GGUF](https://huggingface.co/tencent/Hy-MT2-7B-GGUF/blob/ab8472660ac61fac25f1af43fac2599d52a8a775/LICENSE.txt) |
| 30B-A3B | Apache License, Version 2.0 | [原始](https://huggingface.co/tencent/Hy-MT2-30B-A3B/blob/d3ead4dba61c09aac60a261a96ad1df3e705febb/LICENSE.txt)、[FP8](https://huggingface.co/tencent/Hy-MT2-30B-A3B-FP8/blob/b69671c83c2137c6982209715030df82f0093ee1/LICENSE.txt)、[GGUF](https://huggingface.co/tencent/Hy-MT2-30B-A3B-GGUF/blob/fd3dcbb6b31e9e03923ef4f9f42500f74c3851c3/LICENSE.txt) |

这些仓库的公开模型 API 均返回 `private=false, gated=false`，本次匿名读取元数据与许可成功，无需完成访问批准；这不免除使用/分发时的许可义务。[官方仓库列表 API](https://huggingface.co/api/models?author=tencent&search=Hy-MT2&limit=100&full=true)、[1.8B 固定 API](https://huggingface.co/api/models/tencent/Hy-MT2-1.8B/revision/9a341cd1b679d3efd23b46e847b01745a71ed792)、[7B 固定 API](https://huggingface.co/api/models/tencent/Hy-MT2-7B/revision/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223)、[30B 固定 API](https://huggingface.co/api/models/tencent/Hy-MT2-30B-A3B/revision/d3ead4dba61c09aac60a261a96ad1df3e705febb)。Apache §4 要求分发附许可、保留相关声明及适用的 NOTICE；当前 Hy-MT2 LICENSE 未附旧版的地域或用户规模门槛。[官方总许可](https://github.com/Tencent-Hunyuan/Hy-MT2/blob/ff1903ecaa724e10951a23c16817a2413c752b35/LICENSE.txt)。

旧 Hunyuan-MT-7B / Chimera-7B 实际仍是 **Tencent Hunyuan Community License Agreement（2025-09-01）**：排除欧盟、英国、韩国；发布日所对应的前一自然月、被许可方全部产品/服务 MAU 超过 1 亿须另获腾讯许可；附 AUP，限制用权重/输出改善其他 AI 模型，并规定分发协议和 Notice。Hy-MT2 的 Apache 许可不能自动套给这些旧资产。[旧 MT 实际许可](https://huggingface.co/tencent/Hunyuan-MT-7B/blob/9305c78383f0bcc94358e08667ee2c76107877e3/License.txt)、[旧 Chimera 实际许可](https://huggingface.co/tencent/Hunyuan-MT-Chimera-7B/blob/3d9e4551dad0ae6b9fb6be5e96eee942bfcea047/LICENSE)。

## 已发布独立 GGUF 与固定身份

公开 API 确认以下 10 个单文件 GGUF，已再次用固定 revision 查询核对。GitHub README 模型表未列 30B GGUF，但官方 tencent 仓库实际已发布它。[GitHub 模型表](https://github.com/Tencent-Hunyuan/Hy-MT2/blob/ff1903ecaa724e10951a23c16817a2413c752b35/README.md#model-links)、[30B 文件 API][api-c]。

| 来源 / 官方仓库 | 仓库 commit SHA | API 的 `gguf.architecture` |
| --- | --- | --- |
| [A: tencent/Hy-MT2-1.8B-GGUF][api-a] | `a0c709d9fac510f2c807aa3af52872340dc37a4a` | `hunyuan-dense` |
| [B: tencent/Hy-MT2-7B-GGUF][api-b] | `ab8472660ac61fac25f1af43fac2599d52a8a775` | `hunyuan-dense` |
| [C: tencent/Hy-MT2-30B-A3B-GGUF][api-c] | `fd3dcbb6b31e9e03923ef4f9f42500f74c3851c3` | `hy_v3` |
| [D: tencent/Hy-MT2-1.8B-1.25Bit-GGUF][api-d] | `9df5c824a00a744fb0512a29c640466f4d97dfb0` | `hunyuan-dense` |
| [E: tencent/Hy-MT2-1.8B-2Bit-GGUF][api-e] | `b630487d19ab7f336664a15b07c638d0d1071471` | `hunyuan-dense` |

以下 `bytes` 是文件大小，`SHA256` 是 API 的 LFS 内容哈希，区别于上表仓库 commit 和 Git blob ID；未下载文件重算哈希。精度取实际文件名的发布标签，未读取二进制头确认逐张量类型；各行来源链接均为官方固定文件 API。7B 的 `HY-` / `Hy-` 大小写须原样保留。

| 来源 | 实际文件名 / 发布精度 | bytes | LFS SHA256 |
| --- | --- | ---: | --- |
| [A][api-a] | `Hy-MT2-1.8B-Q4_K_M.gguf` | 1133080448 | `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699` |
| [A][api-a] | `Hy-MT2-1.8B-Q6_K.gguf` | 1474785120 | `d98fe604dec1f28f58f80d7d560f7177e584d3b8e5835862687660e5ff97cb40` |
| [A][api-a] | `Hy-MT2-1.8B-Q8_0.gguf` | 1908528192 | `5c3fe0b1408a5ceb0143184ef247b11b579c525f4b02b060e6c851bb76fef1a4` |
| [B][api-b] | `Hy-MT2-7B-Q4_K_M.gguf` | 4624648896 | `9f96256500f3fc1ab4d64336b58f52a949a95ad7516b0c229476eef782f9f77b` |
| [B][api-b] | `HY-MT2-7B-Q6_K.gguf` | 6164482720 | `88ef0aba59952a4cfe4be36cb5baf797dbb370bc60e9dcbd7297036021e52831` |
| [B][api-b] | `HY-MT2-7B-Q8_0.gguf` | 7981928896 | `58b3ad55dd6f6fa08c695cddc34fb5f8f708a844f78ae10508071914b0ed67c0` |
| [C][api-c] | `Hy-MT2-30B-A3B-Q4_K_M.gguf` | 18236702880 | `bb44b11bb0f7cd3d1321645b41e911cd3de2e473731227fc6bf37aa18b543f88` |
| [C][api-c] | `Hy-MT2-30B-A3B-Q8_0.gguf` | 31985729376 | `d4e74d3b9479db5a7e2e4728879e15554b385e9549b411cc8b0ad03b2970ce98` |
| [D][api-d] | `Hy-MT2-1.8B-1.25Bit.gguf` | 461860800 | `cc497fe8f033b52b3b8b00a7669e9661435432f9d4cd43f7ed24400c01507a93` |
| [E][api-e] | `Hy-MT2-1.8B-2Bit.gguf` | 600534880 | `dcc33bbae9b28d923c8c76a64f6157840841d26f8774f3dfd770d5fabeeb1cd7` |

以上列表没有独立 F16/BF16 GGUF，也没有 30B Q6_K；官方原生/FP8 仓库是另行发布的格式，不能据可转换的精度虚构 GGUF 下载项。[1.8B][api-a]、[7B][api-b]、[30B][api-c]、[官方格式列表](https://github.com/Tencent-Hunyuan/Hy-MT2/blob/ff1903ecaa724e10951a23c16817a2413c752b35/README.md#model-links)。

## 低比特、性能及未验证边界

- **1.25Bit**：官方卡明确称依赖 STQ kernel，并指向 PR #22836。其官方前代 1.5 卡明确写 STQ1_0，以及手动取 PR head 的 `pr-22836-stq_0` 分支；这是特殊内核/补丁路线的证据，不代表 Hy-MT2 已在普通发行版实载通过。[Hy-MT2 1.25Bit 卡](https://huggingface.co/tencent/Hy-MT2-1.8B-1.25Bit-GGUF/blob/9df5c824a00a744fb0512a29c640466f4d97dfb0/README.md)、[官方前代内核说明](https://huggingface.co/tencent/Hy-MT1.5-1.8B-1.25bit-GGUF/blob/3d09c4ce7dc00aa7182cb348a760c7d8f6983224/README.md)。
- **2Bit**：当前官方卡也写 STQ，但引用 PR #19357。其模型/文件 API 只提供架构、尺寸等元数据，不提供逐张量量化类型；**是否实际为 TQ2_0 未验证**，也未核实其必须使用哪个独立 fork，不能根据“2Bit”名称推定普通 llama.cpp 可加载。[2Bit 卡](https://huggingface.co/tencent/Hy-MT2-1.8B-2Bit-GGUF/blob/b630487d19ab7f336664a15b07c638d0d1071471/README.md)、[实际元数据][api-e]。1.25Bit 的二进制 tensor type 同样未直接检查。[元数据][api-d]。
- **普通 Q4/Q6/Q8**：1.8B、7B 卡也含同样的泛用 STQ 警告，但已得元数据没有证明这些标准命名文件含 STQ。记录为文档歧义，不能把特殊 fork 要求自动归到普通量化；复用现有 llama.cpp 的建议仍须真实加载验收。[1.8B 卡](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/blob/a0c709d9fac510f2c807aa3af52872340dc37a4a/README.md)、[7B 卡](https://huggingface.co/tencent/Hy-MT2-7B-GGUF/blob/ab8472660ac61fac25f1af43fac2599d52a8a775/README.md)。
- **宣传与测量分开**：官方宣称 1.25-bit 为 440 MB、推理提速 1.5×，且 1.8B 综合翻译表现超过 Microsoft/Doubao API；这些是作者宣传/评测，本次没有测得日语字幕效果、速度或峰值 RAM/VRAM。[官方模型介绍](https://github.com/Tencent-Hunyuan/Hy-MT2/blob/ff1903ecaa724e10951a23c16817a2413c752b35/README.md#model-introduction)。实际 1.25Bit 文件为 461,860,800 B，约 440.46 MiB；不能将宣传值当运行内存要求。[文件 API][api-d]。规划推断：RAM/VRAM 还取决于缓存、计算缓冲及 CPU/GPU 分配，磁盘字节数不足以制定最低内存承诺；本次无运行内存数据。
- **参数来源不一致**：1.8B 的 `generation_config.json` 是 `top_p=0.8`，README 推荐 `top_p=0.6`；不能笼统宣称只有一套官方默认。保留此差异供父代理的模型 profile/模板工作处理。[固定 generation_config](https://huggingface.co/tencent/Hy-MT2-1.8B/blob/9a341cd1b679d3efd23b46e847b01745a71ed792/generation_config.json)、[README 推荐值](https://github.com/Tencent-Hunyuan/Hy-MT2/blob/ff1903ecaa724e10951a23c16817a2413c752b35/README.md#inference-and-deployment)。

上线前建议用真实日语 cue、短标题/简介和人名术语比较 1.8B Q4/Q6/Q8，并记录质量、首字延迟、吞吐和峰值内存；7B 与特殊低比特各自另验收。本次结论是“值得作为可选模型试验”，不是“已完成本机推理验证”。

## 7B 接入时补充的模板与终止 token 证据

2026-10-07 按用户选择核对 7B。原始 7B 的 [固定模板](https://huggingface.co/tencent/Hy-MT2-7B/blob/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223/chat_template.jinja) 使用 `<|startoftext|>` / `<|extra_0|>` / `<|eos|>`，与 1.8B 模板不同；[生成配置](https://huggingface.co/tencent/Hy-MT2-7B/blob/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223/generation_config.json) 的终止 ID 为 127960 和 127967，[tokenizer 配置](https://huggingface.co/tencent/Hy-MT2-7B/blob/9b0eb4e8f001def3e5ff6469a0ac96fdb39ec223/tokenizer_config.json) 对应 `<|eos|>` 与 `<|extra_5|>`。使用该 7B 专属模板，不借用 1.8B token 或千问思考参数。

从上述固定 GGUF revision 读取 Range 前缀并解析 GGUF v3 元数据：Q4_K_M 的元数据长 7,498,056 B，Q6_K／Q8_0 为 7,498,031 B，三者都是 `hunyuan-dense`、354 个张量，EOS=3、EOT=127960；Q4 的 token 表确认 token 3 是 `$`。Q6_K 的张量类型为 F32／Q6_K（0／14），Q8_0 为 F32／Q8_0（0／8），不含 STQ；这不是完整文件 SHA 重算或推理加载试验。[固定资产来源][api-b]。

因此固定运行策略通过 `--override-kv tokenizer.ggml.eos_token_id=int:127960,tokenizer.ggml.eot_token_id=int:127967` 使用原始模型的两个终止 ID，避免将美元符号作为生成终止；请求同时指定两个原始停止词。固定 llama.cpp 的 [参数解析器](https://github.com/ggml-org/llama.cpp/blob/b11435/common/arg.cpp) 支持整型 metadata override，[词表加载器](https://github.com/ggml-org/llama.cpp/blob/b11435/src/llama-vocab.cpp) 将 EOS／EOT 纳入 EOG 集合。没有重写模型文件；HY 7B 尚未在任何平台完成真实推理验收，实际译文生成、价格文本完整性及本机性能仍待验证。基础运行库的 Kotoba／Qwen 证据不作为 HY 模型的验收。
