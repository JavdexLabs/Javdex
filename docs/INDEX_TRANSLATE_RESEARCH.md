# Index-Translate：B站开源翻译模型有限调研

核对日期：2026-10-07。问题仅为“B站是不是也有开源翻译模型”。按 research 工作流核对官方 GitHub、IndexTeam Hugging Face 模型卡、配置与文件 API，已读 AGENTS.md；本轮仅写本文。
未下载完整权重、安装依赖、接受访问条款、调用托管推理、运行真实推理、改接入代码、提交或推送；不作质量优越性结论。

以上两句描述最初调研轮次。用户随后要求“接入9B的”，下方新增接入核对记录；当前代码及验证范围见 [实施记录](AI_SUBTITLES_IMPLEMENTATION.md#index-translate-9b-可选翻译模型2026-10-07)。完整权重下载与真实 9B 推理仍未执行。

## 答案与发布范围

有：Bilibili 官方发布了 **Index-Translate**，基于 Qwen3.5 的多语言文本翻译模型。官方 README 记录 2026-09-30 发布 2B、9B、35B-A3B（preview），文本范围为 150 种语言；2026-10-03 发布官方 GGUF 等量化构建。[官方 README][github-readme]
官方文本客户端的 `LANG_NAMES` 包含 `ja=日语`、`zh=中文`，源/目标语言接口可表达日文→中文及反向文本翻译；默认 `temperature=0`，并设置 `enable_thinking=False`。这是公开接口与默认值核对，未验证实际译文。[官方 translate.py][translate]

## 许可证：声明与实际文件

GitHub 仓库实际 `LICENSE` 正文为 **Apache License, Version 2.0**，已读取全文。[实际 LICENSE][github-license]
以下四个固定 revision 的模型卡均声明 `apache-2.0`；原始文本模型卡的 License 段还链接上述 GitHub LICENSE。**四个 Hugging Face 仓库均缺少独立 LICENSE 文件**：完整文件清单无 LICENSE/LICENSE.txt，直接读取各 revision 的 `LICENSE` 均返回 404。GGUF 卡只有许可标签，不能写成“已读取各权重仓库的实际 LICENSE”。

| 官方仓库 | 固定 revision | 许可声明 / 文件证据 |
| --- | --- | --- |
| Index-Translate-2B | `a516854233b170140b57d36b48d7148c0edebabb` | [模型卡][card-2b]：Apache-2.0；[文件 API][api-2b]：独立 LICENSE 缺失 |
| Index-Translate-9B | `710123a9274f2486996d6a63b8d4909a51c4315d` | [模型卡][card-9b]：Apache-2.0；[文件 API][api-9b]：独立 LICENSE 缺失 |
| Index-Translate-2B-GGUF | `449c9e6457b3632d328c6cbb78ae8e8e0c8059a5` | [模型卡][card-2b-gguf]：Apache-2.0；[文件 API][api-2b-gguf]：独立 LICENSE 缺失 |
| Index-Translate-9B-GGUF | `d01404384ba429b93f5f63d43573812d103b5bcd` | [模型卡][card-9b-gguf]：Apache-2.0；[文件 API][api-9b-gguf]：独立 LICENSE 缺失 |

四份固定 API 均返回 `private=false, gated=false`，本次匿名读取元数据与文本成功。[2B][api-2b]、[9B][api-9b]、[2B GGUF][api-2b-gguf]、[9B GGUF][api-9b-gguf]

## 架构与代表性 GGUF 资产

2B/9B 原始 `config.json` 均为 `architectures=["Qwen3_5ForConditionalGeneration"]`、`model_type=qwen3_5`，文本子配置为 `qwen3_5_text`，交替使用 linear/full attention；2B 为 24 层、hidden_size=2048，9B 为 32 层、hidden_size=4096。两者还含 vision_config。[2B 配置][config-2b]、[9B 配置][config-9b]
官方 GGUF API 的架构标识均为 `qwen35`。Q4_K_M、Q6_K、Q8_0 在两仓库中都实际存在；下表为 API 文件大小，GB 按十进制换算，未下载文件核验二进制或重算哈希。[2B 资产][api-2b-gguf]、[9B 资产][api-9b-gguf]

| 实际文件名 | bytes | 约 GB |
| --- | ---: | ---: |
| `Index-Translate-2B.Q4_K_M.gguf` | 1,312,164,352 | 1.31 |
| `Index-Translate-2B.Q6_K.gguf` | 1,606,323,712 | 1.61 |
| `Index-Translate-2B.Q8_0.gguf` | 2,076,674,560 | 2.08 |
| `Index-Translate-9B.Q4_K_M.gguf` | 5,780,090,304 | 5.78 |
| `Index-Translate-9B.Q6_K.gguf` | 7,558,901,184 | 7.56 |
| `Index-Translate-9B.Q8_0.gguf` | 9,786,060,224 | 9.79 |

两仓库另有 f16 及其他量化文件、mmproj 视觉投影附件；官方卡明确纯文本翻译只需普通 GGUF。磁盘文件大小不代表推理 RAM/VRAM 要求。[2B GGUF 卡][card-2b-gguf]、[9B GGUF 卡][card-9b-gguf]

## 文本、语音与验证边界

Index-Translate 的 150 语种是官方文本覆盖声明。Index-Echo S2TT 的已打包语音→字幕接口仅列中文→英语/日语/西班牙语，不能据此承诺日语音频→中文字幕；S2ST 的语音→语音包另列 zh→en/es/ja、en→zh/es/ja。[官方模型表][github-readme]、[S2TT 官方卡](https://huggingface.co/IndexTeam/Index-Echo-S2TT-2B)
Index-Echo GGUF 只包含 LLM backbone，未包含音频塔、connector 和完整语音管线；单个 GGUF 不构成可运行的完整语音翻译系统。[Echo GGUF 官方说明](https://huggingface.co/IndexTeam/Index-Echo-S2TT-2B-GGUF)
主代理已另行核对 Javdex 固定 llama.cpp `b11435` 的 `src/models/qwen35.cpp` 有匹配 2B/9B 架构的分支，仅支持静态可行性判断，本轮未重复检查。[固定版本源码](https://github.com/ggml-org/llama.cpp/blob/b11435/src/models/qwen35.cpp)
真实加载、日文→中文译文质量、速度和内存仍未验证；本文不扩展为接入方案，也不声称优于其他翻译模型。

## 9B 接入核对补充（2026-10-07）

采用已有 llama.cpp 本地翻译链路，供 AI 字幕及本地文本翻译共用；默认 Qwen 与已保存 HY 选择不改变。只注册官方 9B 的全部 12 档纯文本 GGUF，下表的文件名、bytes 和 SHA-256 逐一与固定 [文件 API][api-9b-gguf] 及 [`SHA256SUMS.txt`](https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF/blob/d01404384ba429b93f5f63d43573812d103b5bcd/SHA256SUMS.txt) 核对，哈希完整值保存在 `apps/desktop/src/main/services/localModels/modelCatalogAssets.json`。这里是上游元数据比对，不是下载完整文件后重算哈希。

| 精度 | 官方文件名 | bytes |
| --- | --- | ---: |
| Q2_K | `Index-Translate-9B.Q2_K.gguf` | 3,914,968,512 |
| Q3_K_S | `Index-Translate-9B.Q3_K_S.gguf` | 4,364,021,184 |
| Q3_K_M | `Index-Translate-9B.Q3_K_M.gguf` | 4,737,609,152 |
| Q3_K_L | `Index-Translate-9B.Q3_K_L.gguf` | 5,048,511,936 |
| IQ4_XS | `Index-Translate-9B.IQ4_XS.gguf` | 5,357,874,624 |
| Q4_K_S | `Index-Translate-9B.Q4_K_S.gguf` | 5,488,553,408 |
| Q4_K_M | `Index-Translate-9B.Q4_K_M.gguf` | 5,780,090,304 |
| Q5_K_S | `Index-Translate-9B.Q5_K_S.gguf` | 6,472,641,984 |
| Q5_K_M | `Index-Translate-9B.Q5_K_M.gguf` | 6,642,544,064 |
| Q6_K | `Index-Translate-9B.Q6_K.gguf` | 7,558,901,184 |
| Q8_0 | `Index-Translate-9B.Q8_0.gguf` | 9,786,060,224 |
| F16 | `Index-Translate-9B.f16.gguf` | 18,407,321,024 |

初始精度 Q4_K_M 约 5.78 GB；下载不自动激活翻译模型。不注册同仓库的 `Index-Translate-9B.mmproj-Q8_0.gguf`／`mmproj-f16.gguf`；纯文本翻译不需视觉附件。许可保持准确表述：模型卡声明 Apache-2.0，正文使用固定官方 GitHub 项目的 LICENSE，HF 权重仓库没有独立 LICENSE。[模型卡][card-9b-gguf]、[实际许可][github-license]

按 [官方文本客户端][translate] 使用确定性解码、关闭思考及 `【源文】`／`【约束要求】`／`【硬性要求】` 格式。仅检查 Q4_K_M 的 32 MiB Range 前缀，元数据结束于 byte 10,942,406：GGUF v3、442 张量、`qwen35.block_count=33`、`nextn_predict_layers=1`，即 32 主干层加 1 个 MTP 层；并非原生 32 层与转换结果不兼容。EOS 为 248044，与原生生成配置一致；没有显式 EOT key，应用请求设置 `<|endoftext|>`／`<|im_end|>` 停止词。嵌入的 Jinja 模板与原生固定 tokenizer_config 逐字一致。[原生 tokenizer](https://huggingface.co/IndexTeam/Index-Translate-9B/blob/710123a9274f2486996d6a63b8d4909a51c4315d/tokenizer_config.json)、[原生 generation_config](https://huggingface.co/IndexTeam/Index-Translate-9B/blob/710123a9274f2486996d6a63b8d4909a51c4315d/generation_config.json)

固定 [llama.cpp b11435 的 Qwen3.5 实现](https://github.com/ggml-org/llama.cpp/blob/b11435/src/models/qwen35.cpp) 具有 9B 主干及 MTP 张量分支；静态源码／头部核对不等同于真实加载验收。文件管理与界面检查在本机 macOS 执行。Index 9B 尚未在任何平台完成真实推理验收，未测日中译文质量、速度、断网运行和峰值内存；后续基础运行库的 macOS／Linux Kotoba／Qwen 实测证据见 [实施记录](AI_SUBTITLES_IMPLEMENTATION.md#macoslinux-运行库适配2026-10-07)，不得算作 Index 验收。

[github-readme]: https://github.com/bilibili/Index-Translate/blob/dcccfacd96bd53363650744566dffc87acc2c2fc/README.md
[github-license]: https://github.com/bilibili/Index-Translate/blob/dcccfacd96bd53363650744566dffc87acc2c2fc/LICENSE
[translate]: https://github.com/bilibili/Index-Translate/blob/dcccfacd96bd53363650744566dffc87acc2c2fc/inference/llm/translate.py
[card-2b]: https://huggingface.co/IndexTeam/Index-Translate-2B/blob/a516854233b170140b57d36b48d7148c0edebabb/README.md
[card-9b]: https://huggingface.co/IndexTeam/Index-Translate-9B/blob/710123a9274f2486996d6a63b8d4909a51c4315d/README.md
[card-2b-gguf]: https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF/blob/449c9e6457b3632d328c6cbb78ae8e8e0c8059a5/README.md
[card-9b-gguf]: https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF/blob/d01404384ba429b93f5f63d43573812d103b5bcd/README.md
[api-2b]: https://huggingface.co/api/models/IndexTeam/Index-Translate-2B/revision/a516854233b170140b57d36b48d7148c0edebabb?blobs=true
[api-9b]: https://huggingface.co/api/models/IndexTeam/Index-Translate-9B/revision/710123a9274f2486996d6a63b8d4909a51c4315d?blobs=true
[api-2b-gguf]: https://huggingface.co/api/models/IndexTeam/Index-Translate-2B-GGUF/revision/449c9e6457b3632d328c6cbb78ae8e8e0c8059a5?blobs=true
[api-9b-gguf]: https://huggingface.co/api/models/IndexTeam/Index-Translate-9B-GGUF/revision/d01404384ba429b93f5f63d43573812d103b5bcd?blobs=true
[config-2b]: https://huggingface.co/IndexTeam/Index-Translate-2B/blob/a516854233b170140b57d36b48d7148c0edebabb/config.json
[config-9b]: https://huggingface.co/IndexTeam/Index-Translate-9B/blob/710123a9274f2486996d6a63b8d4909a51c4315d/config.json
