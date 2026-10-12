# 本地模型商店：固定资产目录

调研日期：2026-10-07。范围：模型发布者的模型卡、固定版本源码和公开元数据 API；未登录、接受条款、安装依赖、下载模型权重或运行推理。本文件只提供研究证据，不代表 Javdex 已支持或验收这些执行路径。

## 应用当前选用范围（2026-10-10）

Qwen3 1.7B 从 25 个文件精简为以下 4 档，下载、导入和用途选择共用该目录，默认推荐仍为 Q4_K_M。保留文件的固定 revision、SHA-256 与大小不变；应用尚未发布，不增加旧配置兼容或迁移逻辑。Kotoba 2 档和 HY-MT2 7B 3 档保持不变，应用目录合计 9 个文件。此精简不代表各档翻译效果已经实测。

| 精度 | 发布者 | 下载大小（GB） |
| --- | --- | --- |
| Q4_K_M（推荐） | bartowski | 1.28 |
| Q5_K_M | bartowski | 1.47 |
| Q6_K | bartowski | 1.67 |
| Q8_0 | Qwen | 1.83 |

## 上游发布调查（2026-10-07）

以下是上游发布资产的历史调查，不代表应用当前提供全部文件。

**已核实**：指定仓库共发布 27 个独立 GGML/GGUF 权重文件：Kotoba 2 个、bartowski Qwen3-1.7B 24 个、Qwen 官方 1 个。已再次请求各固定 revision 的 API，逐项核对文件数、文件名、LFS SHA256 和字节大小。下列数据不包含校准 `imatrix`、示例音频或训练产物，也未把运行时能自行量化的类型当作已发布文件。

来源：[Kotoba 固定版本 API](https://huggingface.co/api/models/kotoba-tech/kotoba-whisper-v2.0-ggml/revision/e3a0cf6a62b95911703cfb97d819292e058f12c3?blobs=true)、[bartowski 固定版本 API](https://huggingface.co/api/models/bartowski/Qwen_Qwen3-1.7B-GGUF/revision/dcb19155b962dbb6389f4691a982043a8e651022?blobs=true)、[Qwen 官方固定版本 API](https://huggingface.co/api/models/Qwen/Qwen3-1.7B-GGUF/revision/90862c4b9d2787eaed51d12237eafdfe7c5f6077?blobs=true)。

- Kotoba：原始 GGML、`Q5_0`；本仓库没有 `Q4_0/Q5_1/Q8_0/F32` 的发布文件。下面原始 GGML 的 `F16` 标签是**基于转换指令的推断**：发布者没有传 `use-f32`，转换器默认 F16，并保留部分小张量 F32；本次未读取二进制文件头。见[发布者转换说明](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/blob/e3a0cf6a62b95911703cfb97d819292e058f12c3/README.md)、[固定转换器](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/models/convert-h5-to-ggml.py#L111)。
- bartowski：`bf16, Q8_0, Q6_K_L, Q6_K, Q5_K_L, Q5_K_M, Q5_K_S, Q4_K_L, Q4_K_M, Q4_K_S, Q4_1, Q4_0, Q3_K_XL, Q3_K_L, Q3_K_M, Q3_K_S, Q2_K_L, Q2_K, IQ4_NL, IQ4_XS, IQ3_M, IQ3_XS, IQ3_XXS, IQ2_M`。所有文件均独立、未分片；低位精度能加载不代表字幕翻译质量已验证。发布者记录使用 llama.cpp `b5200`，部分 `_L/_XL` 是嵌入/输出层采用 Q8_0 的混合精度。见[发布者固定模型卡](https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/blob/dcb19155b962dbb6389f4691a982043a8e651022/README.md)。
- Qwen 官方：仅 `Q8_0`。官方和 bartowski 的 Q8_0 文件大小、文件名、hash 均不同，必须保留发布者身份。官方模型卡说明 llama.cpp/Ollama 执行路径；不能仅按精度名将两个文件互换。见[官方固定模型卡](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/blob/90862c4b9d2787eaed51d12237eafdfe7c5f6077/README.md)。

### 固定资产清单

`size` 单位为 byte；`sha256` 来自 LFS 内容哈希，**不是** Git `blobId` 或仓库 commit。下载地址应为 `https://huggingface.co/{repoId}/resolve/{revision}/{rfilename}`。使用真实 `rfilename`：bartowski 模型卡部分链接写成 `Qwen3-...`，实际文件为 `Qwen_Qwen3-...`。

```json
[
  {
    "repoId": "kotoba-tech/kotoba-whisper-v2.0-ggml",
    "revision": "e3a0cf6a62b95911703cfb97d819292e058f12c3",
    "assets": [
      {"precision":"Q5_0","rfilename":"ggml-kotoba-whisper-v2.0-q5_0.bin","sha256":"4a3b92192b5d3578ff854a5876213e2e27af0c2d357492c2d14271e82c303658","size":537819875},
      {"precision":"F16","rfilename":"ggml-kotoba-whisper-v2.0.bin","sha256":"eff70a8a236e731abba774ba71e1f6d0fce53302137208c32207e694e0bf4546","size":1519521155}
    ]
  },
  {
    "repoId": "bartowski/Qwen_Qwen3-1.7B-GGUF",
    "revision": "dcb19155b962dbb6389f4691a982043a8e651022",
    "assets": [
      {"precision":"IQ2_M","rfilename":"Qwen_Qwen3-1.7B-IQ2_M.gguf","sha256":"d6f35c090bc6e70437df4080e21a9b0458d568123abfa3ff04e243077edc358c","size":828885408},
      {"precision":"IQ3_M","rfilename":"Qwen_Qwen3-1.7B-IQ3_M.gguf","sha256":"a0abdf07593f058b056531c9168e6733ed8e64cacc28750fb84f46d1044ccab6","size":1029366176},
      {"precision":"IQ3_XS","rfilename":"Qwen_Qwen3-1.7B-IQ3_XS.gguf","sha256":"1b166b349d5c2dc2f717a688018d1878a283c630b7729df3fdaecf76271803f0","size":967926176},
      {"precision":"IQ3_XXS","rfilename":"Qwen_Qwen3-1.7B-IQ3_XXS.gguf","sha256":"5c7649660c508f31f522ac7fa9e70fa03f989250ce9884cc3747f0e6c7443fbe","size":888064416},
      {"precision":"IQ4_NL","rfilename":"Qwen_Qwen3-1.7B-IQ4_NL.gguf","sha256":"66086acac62fe510a0975d60c22b27485f8a7b94bde7b908c8c38edb1891a93a","size":1229453728},
      {"precision":"IQ4_XS","rfilename":"Qwen_Qwen3-1.7B-IQ4_XS.gguf","sha256":"26bb1677b3dbd490e9b0e4e20b2356646f3a43819e795b39f772fdac07ba091d","size":1175689632},
      {"precision":"Q2_K","rfilename":"Qwen_Qwen3-1.7B-Q2_K.gguf","sha256":"10bfbf421f9c9a631ec1294a6f4005b76d37ea3902d90408a1121315c4b07d21","size":879896992},
      {"precision":"Q2_K_L","rfilename":"Qwen_Qwen3-1.7B-Q2_K_L.gguf","sha256":"ec641bc2d026bd18a8bd9a4f136c5751aa44eed792908a4b36dca396f44feb17","size":1183768992},
      {"precision":"Q3_K_L","rfilename":"Qwen_Qwen3-1.7B-Q3_K_L.gguf","sha256":"088aa1cedfee641acdf4c51c80d02c7fd145b3bb41e7e29d155759fd19cd7a09","size":1137205664},
      {"precision":"Q3_K_M","rfilename":"Qwen_Qwen3-1.7B-Q3_K_M.gguf","sha256":"d544d30dbb7b2f608775d69c939a9b8d89c45df2be1a5ad1390ddc1bd7f8d6f5","size":1073242528},
      {"precision":"Q3_K_S","rfilename":"Qwen_Qwen3-1.7B-Q3_K_S.gguf","sha256":"6b7ecc78b5941d658c5fb055c7987d4f7fe5289da64bb92e99d8022c99ce81c3","size":1000956320},
      {"precision":"Q3_K_XL","rfilename":"Qwen_Qwen3-1.7B-Q3_K_XL.gguf","sha256":"0d33ed05b725dacd31f0bf9056ca6ef6e75558da735cfb5f95b23d85f531f92b","size":1409474976},
      {"precision":"Q4_0","rfilename":"Qwen_Qwen3-1.7B-Q4_0.gguf","sha256":"c470091d31c4ada174ee5c2547daa020e930593cbca5ca8ca385ce8ff59a2fdf","size":1231813024},
      {"precision":"Q4_1","rfilename":"Qwen_Qwen3-1.7B-Q4_1.gguf","sha256":"c0285c63df86c805ec1837441ee4fcb44bc7baa7371061bcbe40036a0ce93dfe","size":1336981920},
      {"precision":"Q4_K_L","rfilename":"Qwen_Qwen3-1.7B-Q4_K_L.gguf","sha256":"82479bad9c6e9d915c7bb6dd7b99db0c550e27d5d94d32d7bd4c7d02309713cc","size":1513382304},
      {"precision":"Q4_K_M","rfilename":"Qwen_Qwen3-1.7B-Q4_K_M.gguf","sha256":"72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb","size":1282439584},
      {"precision":"Q4_K_S","rfilename":"Qwen_Qwen3-1.7B-Q4_K_S.gguf","sha256":"9ad5c47ea747ef747d2941ae588f3770884203efb1ba517c5a5f1418af66296d","size":1235220896},
      {"precision":"Q5_K_L","rfilename":"Qwen_Qwen3-1.7B-Q5_K_L.gguf","sha256":"6842a8923337690e7e90daa7450351906a3a02547638833d5c6303fb768a1422","size":1663852960},
      {"precision":"Q5_K_M","rfilename":"Qwen_Qwen3-1.7B-Q5_K_M.gguf","sha256":"4287aca1b231f27dbd20012c4bf9693c89b6c849dc02b7027096da54564d4037","size":1471805856},
      {"precision":"Q5_K_S","rfilename":"Qwen_Qwen3-1.7B-Q5_K_S.gguf","sha256":"d5375dde435a489958730b8cde82f645506903439c705b845c7fc9e32188dc9c","size":1444510112},
      {"precision":"Q6_K","rfilename":"Qwen_Qwen3-1.7B-Q6_K.gguf","sha256":"95aec3c8e76caf949b5a7a3b02adbb7e307eb0aa55880f6a6f9fb5f46abe6d4f","size":1673007520},
      {"precision":"Q6_K_L","rfilename":"Qwen_Qwen3-1.7B-Q6_K_L.gguf","sha256":"4d87f3f55563b5e38e000e64cd67b315fe705bc1748ea27f9bbf2a88d72e2aa6","size":1823728032},
      {"precision":"Q8_0","rfilename":"Qwen_Qwen3-1.7B-Q8_0.gguf","sha256":"74bb7c53538ab2cc81b93f0c64da14a503159de68cff3c6770428d3850479db3","size":2165039520},
      {"precision":"bf16","rfilename":"Qwen_Qwen3-1.7B-bf16.gguf","sha256":"199b4df12194e24ac097d4fcbd279ce62bd4959bed9f0d4719d05a6ab1501861","size":4069679264}
    ]
  },
  {
    "repoId": "Qwen/Qwen3-1.7B-GGUF",
    "revision": "90862c4b9d2787eaed51d12237eafdfe7c5f6077",
    "assets": [
      {"precision":"Q8_0","rfilename":"Qwen3-1.7B-Q8_0.gguf","sha256":"061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a","size":1834426016}
    ]
  }
]
```
