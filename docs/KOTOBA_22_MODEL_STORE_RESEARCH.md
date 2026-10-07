# Kotoba 2.2 与本地模型商店：可执行边界和资产目录

调研日期：2026-10-07。范围：模型发布者的模型卡、固定版本源码和公开元数据 API；未登录、接受条款、安装依赖、下载模型权重或运行推理。本文件只提供研究证据，不代表 Javdex 已支持或验收这些执行路径。

## 1. 可立即用于商店的目录

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

### Transformers 原生格式的边界

v2.2 是在 v2.0 ASR 系列上加入后处理，并非新增 GGML 权重。两者也不是字节相同的 Safetensors 文件：v2.2 配置为 FP32，`model.safetensors` 为 3,025,686,376 B、SHA256 `e0ef3e7b379515f0c35d0e7885638ddef0fa9f5c8e3e3f88cbc6da9b39edd1e9`；v2.0 配置为 BF16，文件为 1,512,875,008 B、SHA256 `0a96a84e307bbb90128a9fd5a45b4f803be212aadef633e24c088fa1ba30f727`。模型卡的“基于 v2.0”不能作为两文件相同的证明；未下载张量验证数值等价。见[v2.2 固定配置](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.2/blob/9d33482a0eb9b57f1ad80708e8ac5538246d8355/config.json)、[v2.0 固定配置](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0/blob/7eb575277d18909a4af8a24e3ae8cce2e99794ae/config.json)及[v2.2 元数据](https://huggingface.co/api/models/kotoba-tech/kotoba-whisper-v2.2/revision/9d33482a0eb9b57f1ad80708e8ac5538246d8355?blobs=true)、[v2.0 元数据](https://huggingface.co/api/models/kotoba-tech/kotoba-whisper-v2.0/revision/7eb575277d18909a4af8a24e3ae8cce2e99794ae?blobs=true)。

这两种原生格式不能交给 whisper.cpp；若商店仅支持 GGML/GGUF，明确标记为另一运行时所需资产，不伪造对应 FP32/BF16 GGML 选项。加载时的 `torch_dtype` 转换也不是新增发布精度。

## 2. Kotoba 2.2 的执行要求

| 路径 | 已有上游支持 | Javdex 仍需完成 |
| --- | --- | --- |
| whisper.cpp + 上述 Kotoba GGML | 日语 ASR；发布者给出原始与 Q5_0 示例 | 单独使用不会得到 v2.2 的 pyannote/diarizers 分离或 punctuators 标点；功能状态必须如实显示 |
| 固定 v2.2 Transformers Python 管线 | 自定义 `KotobaWhisperPipeline`；CPU 或 CUDA 示例；完整的说话人分离和可选标点入口 | Python/Torch 依赖、原生 Safetensors、所有辅助模型、授权、本地加载及字幕时间轴适配 |
| whisper.cpp ASR + 本地 Python 后处理 | 两套组件分别可用 | **实施建议，未获上游整合/本次运行验证**：先建立说话人时间段，再转写/映射 cue，并逐 cue 或重新对齐标点；不是下载一个 v2.2 GGML 即可完成 |

v2.2 配置通过 `custom_pipelines` 指定 Python 实现，模型卡示例要求 `trust_remote_code=True`。可固定模型与代码到 `9d33482a0eb9b57f1ad80708e8ac5538246d8355`，审阅后包装或随端侧 worker 分发；仅下载权重而使用普通 ASR pipeline 会绕过这些后处理。上游示例没有证明 Apple MPS 或三平台打包成功，CPU/CUDA 示例也不是长片性能验收。见[v2.2 固定模型卡](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.2/blob/9d33482a0eb9b57f1ad80708e8ac5538246d8355/README.md)、[固定管线代码](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.2/blob/9d33482a0eb9b57f1ad80708e8ac5538246d8355/kotoba_whisper.py)。

依赖包括 Torch、Transformers、accelerate、torchaudio、`punctuators==0.0.5`、`pyannote.audio` 和 `diarizers`；路径/bytes 输入还走 FFmpeg。模型卡写 Transformers ≥4.39，但 diarizers 声明 ≥4.40；v2.2 配置记录导出版本 4.45.1。`diarizers` 固定源码为 `f3c8ae500f55ad2b02b719fce1495ea2794ca9fe`，依赖范围还包含 datasets/audio、audiomentations、denoiser 和开发工具。应锁定验证过的依赖交集，不直接执行模型卡的无上限升级命令。pyannote 3.4.0 可作为**待验证的 3.x 候选**；4.x 修改了 token/revision API，旧管线还访问私有 `_segmentation.model`，不能声称最新版兼容。见[diarizers 依赖](https://github.com/huggingface/diarizers/blob/f3c8ae500f55ad2b02b719fce1495ea2794ca9fe/setup.py)、[pyannote 3.4 loader](https://github.com/pyannote/pyannote-audio/blob/853b2ab42c3ccd9ec898459d0ad24adc65167b3d/pyannote/audio/core/pipeline.py#L52)、[pyannote 4.0.7 loader](https://github.com/pyannote/pyannote-audio/blob/b749285c5cdd4636b2edc7f766f1352c8dde9369/src/pyannote/audio/core/pipeline.py#L153)。

### 对字幕合同的两个直接影响

1. **说话人身份**：代码先对一次调用的完整音频分离说话人，再按 speaker timeline 做 ASR chunk。`chunk_length_s=30` 的内部 ASR 切块与“每 30 秒重新调用整条管线”不同。pyannote 每次独立生成 `SPEAKER_00...`，没有跨调用身份状态；同一标签不能当作整部影片的稳定人物 ID。**推论/建议**：需要一次全局分离，或显式按 embeddings 跨窗口匹配并处理重叠、跳转和缓存，否则片段间可能换号。见[固定 Kotoba preprocess](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.2/blob/9d33482a0eb9b57f1ad80708e8ac5538246d8355/kotoba_whisper.py)、[pyannote 标签生成](https://github.com/pyannote/pyannote-audio/blob/853b2ab42c3ccd9ec898459d0ad24adc65167b3d/pyannote/audio/pipelines/speaker_diarization.py#L191)。
2. **标点与时间轴**：`add_punctuation=True` 只改 `text/SPEAKER_*`，不改 `chunks` 或 `chunks/SPEAKER_*` 文本。若整段已经含 `!/?/、/。` 中任一字符，Kotoba 包装器直接跳过标点模型。不能把带标点的聚合文本直接替换带时间的 cue；应保留 cue 时间、提供映射或逐 cue 标点策略。另有**源码确认的时间轴风险，未运行复现**：当前 postprocess 将结束时间算成“ASR 局部起点 + speaker span 终点”，而不是局部结束点加全局偏移，且按 speaker 汇总输出；必须检查排序、跨度和重叠，不直接将其示例 JSON 当作有效 SRT。见[固定 postprocess / Punctuator](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.2/blob/9d33482a0eb9b57f1ad80708e8ac5538246d8355/kotoba_whisper.py)。

## 3. 辅助资产、离线与用户批准

默认先加载 `pyannote/speaker-diarization-3.1`（其配置引用 segmentation-3.0 和 WeSpeaker embedding），再用日语 Callhome 分离模型替换 segmentation；**日语模型公开不等于默认流程免于 gate**。标点懒加载 `1-800-BAD-CODE/xlm-roberta_punctuation_fullstop_truecase`。见[pyannote 发布者固定配置](https://github.com/pyannote/hf-speaker-diarization-3.1/blob/0c6d72ac70c2dca2b11b236f5ca3d54d0c133109/config.yaml)、[Kotoba 固定加载代码](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.2/blob/9d33482a0eb9b57f1ad80708e8ac5538246d8355/kotoba_whisper.py)。

| 辅助仓库 | 固定 revision | 访问/模型卡许可 | 运行所需主要权重：bytes / LFS SHA256 |
| --- | --- | --- | --- |
| [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1/tree/84fd25912480287da0247647c3d2b4853cb3ee5d) | `84fd25912480287da0247647c3d2b4853cb3ee5d` | 需用户批准（auto）；mit | 管线配置，含 `config.yaml`（469 B），不是独立 ASR 权重 |
| [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0/tree/e66f3d3b9eb0873085418a7b813d3b369bf160bb) | `e66f3d3b9eb0873085418a7b813d3b369bf160bb` | 需用户批准（auto）；mit | `pytorch_model.bin`：5905440 B；`da85c29829d4002daedd676e012936488234d9255e65e86dfab9bec6b1729298` |
| [pyannote/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM/tree/837717ddb9ff5507820346191109dc79c958d614) | `837717ddb9ff5507820346191109dc79c958d614` | 公开；cc-by-4.0 | `pytorch_model.bin`：26645418 B；`366edf44f4c80889a3eb7a9d7bdf02c4aede3127f7dd15e274dcdb826b143c56` |
| [diarizers-community/speaker-segmentation-fine-tuned-callhome-jpn](https://huggingface.co/diarizers-community/speaker-segmentation-fine-tuned-callhome-jpn/tree/60aec22381cc5946c8b1178df8858e5adaceb3ae) | `60aec22381cc5946c8b1178df8858e5adaceb3ae` | 公开；mit | `model.safetensors`：5899124 B；`7e564d29886a55589fc49f268863dcde32b3babbeaed10fed3562123ac0a4ea3` |
| [1-800-BAD-CODE/xlm-roberta_punctuation_fullstop_truecase](https://huggingface.co/1-800-BAD-CODE/xlm-roberta_punctuation_fullstop_truecase/tree/d1769a597ce8dfaa070d436bc67d4ee761f58884) | `d1769a597ce8dfaa070d436bc67d4ee761f58884` | 公开；apache-2.0 | `model.onnx`：1112481438 B；`c43ca686dabc237c3b06be834b9423c07580fef7e2b1a6c09976f7d60caa5d89`<br>`sp.model`：5069059 B；`7f944d0be93b275f62e1913fd409f378ddbba108e57fe4a9cb47e8c047f6bef1` |

辅助清单来源：各仓库的[公开模型 API](https://huggingface.co/docs/hub/api#model-api)与上表固定仓库页面；仅选运行文件。标点还需 `config.yaml`（531 B），不需训练用 `.nemo` 或训练日志。

`punctuators==0.0.5` 的确切依赖为 `onnxruntime, torch>=1.9, sentencepiece, huggingface-hub, omegaconf, numpy`。本次仅在内存检查其 10,176 B 发布 wheel，SHA256 `54881fada01233a3dc0e8bd05f43f2851c97c2e32ba94c4fde8de64970a63ea3`；没有安装。该版 `from_pretrained` 将带斜杠的输入当作 Hub repo，不能简单传绝对目录；本地路径可通过 `PunctCapSegConfigONNX(directory=...)` 构造加载。0.0.5 不提供 ONNX provider 参数，不能据当前仓库 0.0.7 的接口宣称可直接配置 CUDA。见[版本发布元数据](https://pypi.org/pypi/punctuators/0.0.5/json)、[确切发布 wheel](https://files.pythonhosted.org/packages/42/fe/de4f4f9fc864dbfdec56b4e7a8147623a8820248b5a28771f21b6088a14d/punctuators-0.0.5-py3-none-any.whl)、[当前 owner 源码用于区别版本](https://github.com/1-800-BAD-CODE/punctuators/blob/e0723a4f5dfe5f4fac8571a916ea03571b87edd3/punctuators/models/punc_cap_seg_model.py)。

**离线实施要求**：ASR/tokenizer、pyannote 本地 YAML 及其模型路径、日语 diarizers 模型、标点 ONNX/词表/配置都要固定并完整落盘；Kotoba 默认标点实例也需接入本地 loader。pyannote 3.x 支持本地配置；owner 仓库收录的离线 notebook 特别说明路径相对于进程 cwd，embedding 文件名应包含 `pyannote`，否则可能误判成 ONNX WeSpeaker。使用绝对路径并保持正确 loader 类型。仅暖缓存仍可能产生 Hub 更新检查；`HF_HUB_OFFLINE=1` 可禁止 Hub 请求，但不证明所有库/URL 输入均已离线，仍须断网冷启动验证。见[owner 仓库收录的离线范例（社区贡献）](https://github.com/pyannote/pyannote-audio/blob/853b2ab42c3ccd9ec898459d0ad24adc65167b3d/tutorials/community/offline_usage_speaker_diarization.ipynb)、[Hub 离线行为](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables#hfhuboffline)。

**需要用户明确批准的选择**：要启用默认 v2.2 分离链，用户须以自己的 Hugging Face 账号分别同意 [speaker-diarization-3.1 条件](https://huggingface.co/pyannote/speaker-diarization-3.1) 和 [segmentation-3.0 条件](https://huggingface.co/pyannote/segmentation-3.0)，并提供具备这两仓库读取权限的 token。两者公开 API 标记 `gated=auto`，模型卡说明分享联系信息、公司/学校和网站，并可能收到高级产品邮件；MIT 许可不取消该访问步骤。用户未批准时，商店/分离状态应说明“等待授权”，可以继续提供公开 ASR 资产；不要自动接受条款。改为用户导入合法获得的本地模型可以避免本次 Hub 登录，但不等于绕过获取许可；改用另一公开 pipeline 则是另一个需要验证的执行方案。本次未执行任何批准操作。

## 4. 给实现方的最小要求

- 资产身份使用 `repoId + revision + rfilename`，读取本清单的 `size/sha256`；原子下载、取消/续传、完成后 hash 校验，不能用“同名文件存在”认定安装成功。
- 商店列出全部上述可下载精度，默认推荐与其他可选精度分开；运行时不支持的格式/后端明确禁用，不编造缺失发布文件。Qwen 官方 Q8_0 与 bartowski Q8_0 分别管理；应用可继续默认选择 bartowski Q4_K_M。
- “ASR 权重已安装”“完整分离/标点依赖齐全”“运行时可用”分别检查；辅助模型的额外磁盘占用和授权状态纳入安装计划，不把 Kotoba GGML 已下载显示为 v2.2 全能力已就绪。
- 真正的 v2.2 字幕能力须实现跨片段说话人身份、标点到 cue 的映射和时间轴验证；先用固定依赖和本地模型验证，再承诺完整离线和跨平台性能。上述是实施要求/建议，本次仅验证发布事实。
