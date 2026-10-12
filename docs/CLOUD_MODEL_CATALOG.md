# 云端模型目录

核对日期：2026-10-11。预设位于 `packages/contracts/src/llmProviders.ts`，只保留少量当前生成模型；完整目录通过供应商详情的“远程查询”获取。各供应商的模型 ID 独立核对，不推断聚合平台已支持上游最新型号。

| 供应商 | 本次预设模型 ID | 官方依据 |
| --- | --- | --- |
| OpenAI | `gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-luna` | [模型目录](https://developers.openai.com/api/docs/models)、[接口迁移说明](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra) |
| Anthropic | `claude-fable-5-1`、`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5` | [模型概览](https://platform.claude.com/docs/en/models/overview) |
| DeepSeek | `deepseek-flash`、`deepseek-v4-pro` | [API 文档](https://api-docs.deepseek.com/)、[模型与价格](https://api-docs.deepseek.com/quick_start/pricing) |
| Moonshot | `kimi-k3` | [Kimi K3 官方发布说明](https://forum.moonshot.ai/t/kimi-k3-is-here-our-most-capable-model/480) |
| 智谱 AI | `glm-5.3`、`glm-5.3-flash`、`glm-5.3-flashx` | [模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[Flash 系列](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash) |
| MiniMax | `MiniMax-M3`、`MiniMax-M2.7`、`MiniMax-M2.7-highspeed` | [模型介绍](https://platform.minimax.cn/docs/guides/models-intro) |
| Google Gemini | `gemini-3.8-flash`、`gemini-3.5-flash-lite` | [模型目录](https://ai.google.dev/gemini-api/docs/models) |
| 阿里云百炼 | `qwen3.8-max`、`qwen3.7-plus`、`qwen3.8-flash` | [模型列表](https://help.aliyun.com/zh/model-studio/models) |
| SiliconFlow | `deepseek-ai/DeepSeek-V4-Flash`、`deepseek-ai/DeepSeek-V4-Pro`、`Qwen/Qwen3.6-27B`、`Qwen/Qwen3.6-35B-A3B`、`Pro/zai-org/GLM-5.1` | [发布记录](https://docs.siliconflow.cn/docs/release-notes/overview)、[调用示例](https://docs.siliconflow.cn/docs/userguide/capabilities/stream-mode) |
| OpenRouter | `openai/gpt-6.1-sol`、`anthropic/claude-sonnet-5.5`、`deepseek/deepseek-v4.1-flash` | [公开模型目录](https://openrouter.ai/api/v1/models) |
| Ollama、LM Studio | 无固定预设 | 通过已配置本地服务查询实际加载的模型 |

OpenAI 新预设统一使用 Responses，以支持生成与 Agent 工具调用；更新已有连接时不强制修改其协议。未纳入只向特定套餐开放的 MiniMax M3.1 Flash Preview、受限访问模型，以及需要不同调用流程的 Live、TTS、图片或视频生成型号。

MiniMax 新连接默认使用 [官方推荐的 Anthropic Messages](https://platform.minimax.cn/docs/guides/text-generation)，基础地址 `https://api.minimax.cn/anthropic`；已有连接不强制改动。按 [兼容接口说明](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)，M2 系列思考消耗输出 token 预算，连接测试和短文本翻译至少预留 2048 个输出 token。Agent 工具调用和恢复保留原有 thinking 内容块，包括无签名的思考块。模型查询沿用已保存连接的模型列表端点，不绕过用户配置的网关；端点、账户权限与实际生成仍需用户自己的连接验证。

更新时仅处理过时的内置模型：无用途引用则删除，有引用则转为手动模型并保留配置；仍在目录中的内置模型及用户手动模型保留。已有配置更新规则、手动删除与用途选择见 [用户指南](USER_GUIDE.md)。目录版本及持久化规则见 [开发文档](DEVELOPMENT.md)。预设仅表示官方目录中的可选型号，账户权限、地域、余额和实际生成／工具能力仍需使用用户自己的连接验证；文档核对与公开目录查询不等同于所有账户的付费 API 实测。
