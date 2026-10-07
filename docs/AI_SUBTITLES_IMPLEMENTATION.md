# 离线 AI 双语字幕实施计划

目标：桌面内置播放器使用 Kotoba 边看边生成日语原文及中文译文，支持全屏/窗口、定位优先、缓存复用；音频和字幕不发送到在线模型。Windows 首轮播放验收及后续 macOS／Linux 推理适配的证据分别记录，不等同于所有平台的完整播放／安装验收。

## 决定

- 日语识别：当前为 Kotoba-Whisper v2.0 GGML，默认 Q5_0，可显式切换原始 F16；经独立 whisper.cpp 进程运行。Kotoba 2.2 后处理尚未接入。
- 中文翻译：保留 Qwen3-1.7B 默认及已有精度，可显式改用腾讯 HY-MT2 7B 官方三档 GGUF 或 B站 Index-Translate 9B 官方 12 档纯文本 GGUF；经应用拥有的本机 llama.cpp 服务运行，各模型使用自己的模板和内部参数。绑定回环地址并使用随机凭据，不使用应用在线模型连接。Hy-MT2 实际许可为 Apache-2.0，不沿用旧 Hunyuan-MT 的许可判断；Index 上游模型卡声明 Apache-2.0，许可正文来源单独记录。HY／Index 的真实推理尚未验收。
- 从已授权的影片资源按原始时间提取 16 kHz 单声道音频；不录制系统声音，不改变播放音轨/播放速度。
- 以 30 秒为任务区间，提取时包含边界上下文；当前位置优先，预先处理后续区间。定位取消不再相关的任务，保留已完成缓存。
- 缓存按资源物理身份/版本、音轨、识别及翻译模型版本隔离。日语与译文分别保存。模型/缓存位于本机用户数据目录，源影片不改写。
- 一条生成 ASS 字幕通过 mpv 显示，支持双语/中文/日语；更新不得重开影片或改变视频尺寸。字幕轨道更新失败只影响 AI 字幕，不终止播放。
- 模型与工具固定版本、来源和 SHA-256；权重与下载型运行库按需下载，macOS 识别／音频 CLI 随应用分发。首次下载需联网，安装后识别/翻译完全离线。
- 不保证任意电脑都可实时：生成跟不上时继续播放，展示已识别原文及生成状态，优先补齐当前区间。

## 工作与证据

- [x] 运行环境：固定资产、SHA-256 校验、断点续传、取消、按需安装及清理；真实下载遇到断连后续传成功，二次安装复用全部已校验资产。
- [x] 任务核心：分块/边界、跳转优先、切换音轨/影片隔离、取消、分别缓存及重译；缓存和控制器生命周期测试通过。
- [x] 音频/推理：真实影片提取、Kotoba 日语时间戳、本机翻译、子进程终止及临时文件清理；实际日语音频完成双语生成。
- [x] 字幕：双语 ASS、安全转义、时间轴、增量更新、保留选择及导出 SRT/ASS；真实 mpv 窗口/全屏呈现可见双语字幕，视频只加载一次。
- [x] 界面：设置页统一管理模型及下载进度；播放器字幕页提供生成状态、显示方式、字号、停止、缓存清理与字幕导出。实际 Electron 设置页与字幕页检查通过。
- [x] 验证：67 项相关测试、完整类型检查、全库代码/样式检查、桌面构建及真实离线推理与播放链路通过。

### Windows 实测与边界（2026-10-06）

- 使用 Kotoba 官方公开日语演讲音频，合成 90 秒视频，并加入第二条静音音轨；未读取用户私有影片。
- CPU 模式下首个 30 秒区间识别加翻译约 27–28 秒；缓存再次启用约 45–56 毫秒。结果不等同于任意对白、整部影片或任意硬件的实时保证。
- 禁止非回环地址的推理 fetch 后仍完成字幕生成；首轮模型下载另行执行，远程影片本身的音频读取不属于离线推理边界。
- 验证普通播放时后台生成、窗口/全屏双语像素、单语切换、跳转优先、音轨切换清空旧字幕、停止及缓存重用；原生播放命令错误为 0，视频加载次数为 1。
- 应用退出等待 AI 字幕取消与临时文件清理；实际在正在识别/翻译的任务中退出，应用正常结束（非强制关闭），退出后未残留 whisper-cli / llama-server 进程。
- 单元验证取消后不发布旧结果、翻译失败保留日语、重试不重复识别、私密会话不落新缓存、缓存版本隔离、恢复原字幕及子进程超时/取消。
- 公共演讲样本中存在识别错词和不自然译文。真实轻声对白、背景音乐、非语言发声、复杂音轨及长片速度仍需用户试看；远程服务器端到端播放与正式安装包尚未作为本次验收范围。
- 可重放脚本：`npm run desktop:build` 后运行 `node --import tsx scripts/ai-subtitle-acceptance.mjs --runtime-root <离线模型根目录> --audio <公开日语音频>`。报告与画面保存于忽略目录 `out/playback-acceptance/ai-subtitles/`，不进入安装包。

## 验收场景

普通/轻声日语对白、音乐和静音、非语言发声、分块边界、多个音轨；播放中跳远/连续定位、暂停、倍速、关闭和换片；已生成区间不重复识别；翻译失败仍有原文；重启复用模型与字幕；断网时运行；窗口/全屏字幕同步、更新不黑屏且不改变视频尺寸。

## 统一本地模型管理（2026-10-07）

2026-10-07：模型与运行库改由“设置 → AI 模型 → 本地模型”统一管理，播放器只保留生成/显示及字幕导出入口。新增按模型下载、取消、修复、删除、带许可导出及校验迁移；主进程运行租约保护正在使用的模型。AI 文本翻译可独立选择本地 Qwen3，保持既有在线默认设置及 Agent 用途配置。真实设置页检查涵盖 1440×900 / 1000×640、本机翻译（拒绝外部推理请求）、迁移后翻译、导出哈希与许可、删除单模型及拒绝在线回退；复测统一目录下的播放器字幕通过。可重放 `node --import tsx scripts/local-model-acceptance.mjs`；该脚本在隔离数据目录复制模型，不移动或删除用户模型。

提交前检视补充了快速停止/重启的清理串行化、原字幕恢复和模型租约保护；切换影片会解除旧请求的忙碌状态，过期命令结果不覆盖新字幕事件。翻译方式保存与模型迁移互斥，播放器 IPC 不再提供模型安装/删除命令。对应回归测试通过；Windows 实测再次完成离线字幕、缓存复用、窗口/全屏、音轨切换、推理中退出及模型管理，两套应用均正常退出。

### 模型商店与精度选择（2026-10-07）

目录固定上游发布文件名、仓库 commit、大小和 SHA-256：Kotoba v2.0 GGML 2 个文件、bartowski Qwen3-1.7B GGUF 24 个文件和 Qwen 官方 Q8_0 1 个文件。所有清单来自实际发布资产；Qwen 与 bartowski 的 Q8_0 使用不同身份。原始 Kotoba GGML 的 F16 命名依据上游默认转换方式，未将其当作 v2.2 原生 safetensors 的等价转换结果；证据及精度清单见 [研究记录](KOTOBA_22_MODEL_STORE_RESEARCH.md)。

主进程模型管理模块统一拥有目录、已下载精度、显式选择和运行租约；renderer 只能发送目录内的模型／精度身份，不能提供下载地址、路径或执行命令。`local-models.json` v2 保存所选精度，v1 迁移保留默认权重。下载不自动选择；删除只删除目标精度及其未完成下载，不自动回退；导出记录发布者、来源、精度、哈希和许可。共享运行库和其他精度保留，迁移校验并搬迁整个托管运行目录。

模型文件与推理能力分开：各平台可管理可移植权重；支持的平台下载同时补齐本机运行库，不支持的系统只下载权重，不能通过文件存在绕过推理平台检查。启动推理前检查模型及运行库并持有租约；切换千问精度关闭旧空闲服务。字幕生成冻结模型路径与权重 SHA；识别缓存包含所选识别权重及解码版本，翻译版本包含提示词版本和所选翻译权重，仅重译中文而不重新识别。

验证范围：61 项相关测试覆盖目录、单精度删除、续传／哈希失败、显式选择、迁移与重启、平台能力、译文与识别缓存隔离及界面命令竞态；保留原默认权重的缓存身份。真实 macOS Electron 模型商店检查 27 个目录条目、仅已下载筛选、未下载精度拒绝选择、能力提示及 1440×900／1000×640 布局；该检查不下载真实模型、不代表所有精度的 Windows 推理验收。可重放 `node scripts/local-model-store-acceptance.mjs`，使用独立测试数据目录并正常退出。

### HY-MT2 7B 可选翻译模型（2026-10-07）

以下为接入 HY 时的阶段记录；当前配置版本和累计清单以随后的 Index 小节为准。

按用户选择接入 7B，不引入 1.8B／30B 或特殊低比特运行库。目录增加腾讯官方固定 revision 的 Q4_K_M（4,624,648,896 B）、Q6_K（6,164,482,720 B）和 Q8_0（7,981,928,896 B），共 30 个模型文件；7B 的初始精度是下载较小的 Q4_K_M，不自动改变默认翻译模型。文件身份与实际 Apache-2.0 许可见 [调研记录](HY_MT2_LOCAL_TRANSLATION_RESEARCH.md)。

模型家族由目录显式注册，不再按发布者猜测。`local-models.json` v3 保存活动翻译模型和各家族精度；v1／v2 只读取兼容，不在启动时改写，保留千问、既有精度、文本来源和目录；下一次显式配置时原子写 v3。下载与精度选择不会自动激活另一家族。文本来源仍可保持应用默认，AI 字幕始终使用所选本地翻译模型。删除活动模型不回退，只有恢复下载或显式重新选择后才能继续。

字幕及文本翻译在开始时冻结活动模型并持有对应租约；切换家族和精度关闭旧空闲译文进程，修复任一家族的共享 llama.cpp 可执行文件时排除所有活动翻译租约。迁移保留全部家族与精度，导出使用独立家族名称并附 Apache 许可、来源和腾讯版权声明。存储目录版本保持不变，避免旧模型和工具被无故重新下载。

HY 使用 GGUF 自带的 7B Jinja 模板，不套用 1.8B 模板或千问 `enable_thinking=false`；内部采样按模型卡推荐使用 `top_p=0.6`（原始 generation_config 为 0.8，差异已记录）。检查三份官方 GGUF 的有限 HTTP Range 前缀发现 EOS 都是 token 3（美元符号），EOT 为 127960；启动时通过固定 llama.cpp 的 `--override-kv` 将 EOS／EOT 恢复到原始 7B 的生成终止 ID 127960／127967，并设置对应请求停止词。不修改权重文件。HY 的缓存身份包含独立提示版本和权重 SHA，家族／精度变化只清除中文译文，保留识别结果；千问既有缓存身份不变。

新增回归覆盖官方目录、家族切换与精度选择分离、旧配置兼容、迁移／重启、运行租约、共享运行库修复、无静默回退、独立翻译请求策略、版本缓存和界面命令。HY 接入当时的真实推理证据仅有 Windows x64 的 Qwen／Kotoba；其 macOS 检查不得算作 HY 7B 的真实加载、断网生成、译文效果、速度或峰值内存验收。完整 HY 权重未在本次本机下载或运行；后续基础运行库适配见下节。

HY 接入当时的检查：相关回归 57 项通过，完整 `npm run typecheck`、`npm run pretest`（导入边界、代码／样式规范及 UI 控件检查）和 `npm run desktop:build` 通过。更新后的 `node scripts/local-model-store-acceptance.mjs` 在隔离数据目录执行 9 项真实 Electron 检查，包括全部 30 个目录条目、HY 三档精度、家族显式选择、未下载拒绝启用、来源／内存边界说明及 1440×900／1000×640 布局；应用正常退出（`forced=false, code=0`）。报告和截图位于忽略目录 `out/playback-acceptance/model-store/`。翻译策略测试验证实际请求构造与子进程参数，但使用替身进程，不算真实模型推理。

### macOS／Linux 运行库适配（2026-10-07）

平台差异收敛在资产清单、安装器与构建器，模型商店、所选家族／精度、下载、租约、字幕和文本翻译仍走同一接口；未引入 renderer 执行路径／下载 URL，未改 Web、服务端或默认模型。Windows 原有安装位置、下载资产和未完成下载路径保持；POSIX 工具在 `<运行版本>/tools/<platform>-<arch>/` 分开，三个可移植权重目录保持。

| 平台 | 运行库方案 | 本轮证据 |
| --- | --- | --- |
| Windows x64 | 原有固定 ZIP／CPU 运行库 | 保持来源与存储兼容；本轮未重新运行 Windows 推理 |
| macOS arm64 | 固定源码 whisper b5130／FFmpeg 8.1.3，静态系统库／Metal；llama b11435 官方包 | 实际编译、依赖检查、Kotoba＋Qwen 识别／双语／文本翻译通过 |
| macOS x64 | 同一源码和接口，按 x86_64 交叉编译；独立官方 llama 包 | 三个 CLI 已编译并检查架构／系统库依赖；未在 Intel Mac 运行 |
| Linux arm64 | 固定官方 whisper／llama 与 BtbN LGPL shared FFmpeg 包 | 真实安装、保留 bin/lib 并转普通库别名；断网 Ubuntu 24.04 容器识别／双语／文本翻译通过 |
| Linux x64 | 各自固定的 x64 发布包，同一安装器 | 资产身份、路径与接口回归；未运行完整 x64 推理 |

macOS 官方 llama 包的 Mach-O 最低系统为 13.3。Linux 官方包实际依赖 `GLIBC_2.38`、`GLIBCXX_3.4.32`、`CXXABI_1.3.15`，因此需要 glibc 2.38+ 与 GCC 14 的 C++ 运行库，例如已更新的 Ubuntu 24.04；[GCC ABI 说明](https://gcc.gnu.org/onlinedocs/libstdc++/manual/abi.html) 对应 CXXABI 版本。Debian 12 实际启动被 loader 拒绝，已加入旧 glibc／musl 的前置能力检查，不伪装为通过；没有为这些系统静默切换旧运行库。Linux 解压需 xz-utils。

Mac 编译来源固定至 whisper commit `927cfce34f31707e17f2bff35c349632fb9e2c3a` 与 FFmpeg 8.1.3 完整源码 tar；源码摘要见 `scripts/ai-runtime-sources.json`。普通用户不需要编译器；开发／打包需 CMake、Xcode CLI 与 make。工具在 asar 外分发，保留许可／来源；CLI 先签名并更新哈希，再签外层 app，afterSign 只读验证。真实 ad-hoc stub app 已通过 `codesign --verify --deep --strict`，不等同于正式 DMG 或公证验收。

POSIX 安装不创建压缩包符号链接，而是解析限定于包内的库别名并复制为普通文件，保留 loader 的相对 bin/lib 路径。拒绝路径越界、重复文件、循环／悬空链接和超限压缩包；执行权限与全部清单文件参与安装状态检查，修复再校验完整文件哈希，失败不覆盖原安装。推理子进程不继承外部 `LD_PRELOAD`／`LD_LIBRARY_PATH`／`DYLD_*`，仍只使用受控本机服务。

本轮非 GUI 推理报告在 `out/ai-runtime-acceptance/darwin-arm64/report.json` 与 `linux-arm64/report.json`。使用 macOS Kyoko 合成的日语测试语音，不读取私有影片；Mac 禁止非回环推理 fetch，Linux 使用 Docker `--network none`。均通过四个工具启动、现有模型加载、文本翻译、ffprobe／音频提取、日语时间戳、中文生成与临时 chunk 清理。测试模型位于独立忽略目录，不复制到用户模型目录。短合成语音不能证明真实对白质量、长片实时性或峰值内存。

重放入口（从仓库根开始）：

```bash
npm run ai-runtime:build
node --import tsx scripts/local-ai-platform-acceptance.ts --audio <公开或合成日语音频>
# 已安装后，省略下载，只准许推理连接本机回环地址：
node --import tsx scripts/local-ai-platform-acceptance.ts --offline --audio <同一音频>
```

Linux 检查以 `scripts/local-ai-linux-acceptance.Dockerfile` 为唯一构建 context 中的 Dockerfile；用 esbuild 将 `scripts/local-ai-platform-acceptance.ts` 打包成 `out/ai-runtime-acceptance/platform-smoke.cjs`（Node/CJS）。只挂载专用验收目录为 `/work`，使用 `--network none`，参数为 `--offline --runtime-root /work/runtime --output /work/linux-arm64 --audio /work/sample-ja.aiff`。先用目标平台安装器校验和安装对应运行库、准备共用权重；缺少工具或权重会失败，不用跳过代替通过。此镜像不是应用服务端镜像。

最初平台适配的 87 项相关 Electron 回归通过，无跳过；打包回归 39 项中 37 项通过，另两项明确要求 Windows／Linux 主机，未计为通过。真实模型商店复测 11 项检查，包含支持的平台仍要求先下载模型，1440×900／1000×640 截图已目检，正常退出（`forced=false, code=0`）。提交前复核与新增回归见下节。

真实 macOS 桌面模型管理另完成 6 项隔离检查：由产品 IPC 从应用资源修复 whisper／FFmpeg（禁止外网 fetch）、现有文本翻译 IPC 实际 Qwen 生成、目录迁移后继续翻译、导出权重哈希与许可、删除所选模型后明确报错且不在线回退、恢复默认目录并禁用恢复按钮。目录选择／删除确认弹窗使用替身，其余操作使用产品接口；报告在 `out/playback-acceptance/local-models/report.json`，正常退出（`forced=false, code=0`）。重放命令为 `node --import tsx scripts/local-model-acceptance.mjs --runtime-root out/ai-runtime-acceptance/runtime`。修复了 macOS `/var`／`/private/var` 等价路径使默认目录被误认为自定义目录的问题，并覆盖迁移、旧配置和重启。

完整类型检查、pretest、桌面构建、编码与 diff 检查通过。完整 HY／Index 权重、Intel／Linux x64 实际推理、跨平台播放器、GPU／驱动矩阵与正式安装包仍未在本轮验收，不改变 Kotoba 2.2 后处理未完成的结论。

### Index-Translate 9B 可选翻译模型（2026-10-07）

按用户选择只接入 9B。官方 GGUF 固定 revision 为 `d01404384ba429b93f5f63d43573812d103b5bcd`，12 个纯文本权重的文件名、大小和 SHA-256 与文件 API、`SHA256SUMS.txt` 逐一核对。累计目录 42 个模型文件；9B 初始精度为 Q4_K_M（5,780,090,304 B）。不接入 mmproj、Index-Echo、2B／35B 或 FP4／FP8 管线，完整文件清单与静态证据见 [研究记录](INDEX_TRANSLATE_RESEARCH.md)。

复用模型目录、主进程模型管理、下载器和 llama.cpp，不新增平行推理／下载服务。`local-models.json` v4 增加 Index 家族精度与活动翻译选择；v1–v3 只兼容读取，不在启动时改写。已有 Qwen／HY 模型、精度、保存目录和文本来源保留；显式配置后原子保存 v4。下载与浏览精度不启用模型，运行中租约排除全部翻译家族的共享工具修复，删除活动 Index 精度不会切换到已安装的 Qwen／HY 或在线模型。迁移保留四家族的全部权重；安装和导出附官方模型卡的 Apache 声明及项目许可正文来源。

Index 使用 GGUF 内嵌 Qwen3.5 Jinja 模板，`enable_thinking=false`、`temperature=0`、中性重复惩罚，按官方文本客户端组织源文与约束要求。停止词为 `<|endoftext|>`／`<|im_end|>`，不套用 HY 的 token override 或采样参数。返回译文只允许完整输出；如果仍出现开头的 `<think>` 块，则移除完整块，拒绝未结束的思考块、空译文或截断响应。缓存身份包含独立提示／运行版本与权重 SHA，切换翻译家族／精度只重译中文，不重复日语识别；Qwen 原缓存身份不变。

对 Q4_K_M 仅读取有限 32 MiB HTTP Range 前缀：GGUF v3、`qwen35`、32 个主干层加 1 个 MTP 层、EOS 248044、442 个张量，内嵌模板与原生固定版本 tokenizer 完全一致；该 GGUF 没有显式 EOT 元数据项，应用请求另设停止词。固定 llama.cpp b11435 源码包含 Qwen3.5 9B 主干／MTP 加载分支。上述只证明静态匹配，不代表完整文件哈希重算、模型加载或真实推理。

接入验证：72 项相关回归通过，完整 `npm run typecheck`、`npm run pretest`（导入边界、代码／样式规范及 UI 控件检查）、`npm run desktop:build` 和编码检查通过。隔离数据目录的真实 Electron 模型商店执行 11 项检查，覆盖 42 个条目、Index 12 档精度、未下载拒绝切换、保持默认家族、纯文本与许可边界说明及 1440×900／1000×640 布局；截图已目检，应用正常退出（`forced=false, code=0`）。运行命令与产物目录沿用上一小节。推理请求／子进程测试使用替身；本次 macOS 未下载完整 9B 权重，也未验证 Windows x64 的真实加载、断网推理、日中质量、实时性或峰值内存。

### 提交前复核（2026-10-07）

范围为 `233e20b` 后的未提交代码（模型目录／精度、HY／Index、macOS／Linux 运行库），不重新声明已提交播放器功能全部验收。按规范与需求两个轴并行复核：

- Standards：无文档规范硬性违规；两项维护建议已落实。翻译参数、版本和两类提示词归拢为完整的模型策略映射；返回参数为独立副本，未知模型明确报错。安装与导出共用 HY／Index 版权／许可来源声明。
- Spec：一项旧平台文档描述已修正，明确 Index／HY 自身未在任何平台完成真实推理验收；Kotoba 2.2 仍是待确认依赖的未完成项，不扩展 Web 或服务端范围。
- 主审发现并修复两项功能问题：把翻译、ffprobe／FFmpeg／whisper 与 xz 的环境隔离归于同一子进程规则；模型导出用真实路径检查，拒绝别名／符号链接指向保存目录，并在异步检查前占用操作锁。

90 项相关 Electron 回归通过，无跳过，新增覆盖进程实际环境、导出别名、策略副本与未知模型。重新构建桌面后，模型商店 11 项、实际本地模型管理 6 项均正常退出通过；1440×900／1000×640 布局截图已目检。Mac arm64 与 `--network none` Ubuntu 24.04 arm64 的 Kotoba／Qwen 实际识别、双语及文本翻译复测通过。日志／报告仍在忽略的 `out/ai-runtime-acceptance/` 与 `out/playback-acceptance/`，不作为安装包输入。

最终 `npm test` 退出 0：包含完整 pretest、类型检查、打包测试（37 通过／2 平台跳过）、PGS fixture 3 项、原生构建 5 项；全量 Electron 测试 3,649 项中 3,631 通过、18 明确跳过、0 失败。最新桌面构建、编码及暂存 diff 检查通过，未将平台跳过项计为验收通过。完整日志为 `out/ai-runtime-acceptance/review-tests.log`。

### Kotoba 2.2 尚未实施的依赖边界

官方 v2.2 使用 Transformers／PyTorch 自定义管线并增加 diarizers／pyannote 与 punctuators 后处理，不能只替换 whisper.cpp 权重名称。其原生权重与 v2.0 的数据精度／文件哈希不同，目前商店条目均明确为 v2.0 GGML。[官方 v2.2 资料](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.2)及依赖证据见研究记录。

官方说话人链路还需用户本人接受 pyannote 模型访问条件，并使用其 Hugging Face 只读凭据获取依赖；未代用户接受条件或下载受限模型。是否采用这套运行依赖、千问是否继续 Qwen3-1.7B、角色是否使用跨区间稳定匿名标签，均已向用户提问。此处不记录为已实现或已验收。实施时还必须处理跨 30 秒区间的说话人身份、时间戳字幕的标点回写和冷启动断网验证，不能将每块重置的 `SPEAKER_00` 当作全片稳定角色。

## 官方依据

- https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml
- https://huggingface.co/Qwen/Qwen3-1.7B
- https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF
- https://huggingface.co/tencent/Hy-MT2-7B-GGUF
- https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF
- https://github.com/ggml-org/whisper.cpp
- https://github.com/ggml-org/llama.cpp
- https://mpv.io/manual/stable/#command-interface-sub-reload

参数、效果与性能按模型及平台分别验证；本文勾选项只在有对应证据后更新。
