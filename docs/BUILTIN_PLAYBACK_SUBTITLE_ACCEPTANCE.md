# 内置播放：合成字幕 fixture 依据与验收边界

核对日期：2026-10-03。前三节是研究配方及一手依据，研究本身没有生成媒体或执行验收；最后一节单独记录主任务后续实际运行的 ASS/外挂结果。后续已执行的原创 PGS、失败诊断和受限选轨修复另见 [图像字幕验收合同/结果](BUILTIN_PLAYBACK_BITMAP_ACCEPTANCE.md)，不混写为研究结论。FFmpeg 源码固定到 [`98e92563`](https://github.com/FFmpeg/FFmpeg/tree/98e92563a3b60dbf6d370fd3491d7f896398e4c1)。本机只读工具查询显示 FFmpeg 9.0.2，并具有 `sup` demuxer、Matroska muxer、`pgs_frame_merge`；仅工具查询不是生成或播放成功证据。

## ASS：用明确的空间和时间构造小样本

建议生成 UTF-8 ASS v4+：`ScriptType: v4.00+`，`PlayResX/Y` 与 `LayoutResX/Y` 均为合成视频的显示尺寸（如 1280×720），`ScaledBorderAndShadow: yes`，颜色矩阵匹配视频；固定字体文件、许可、内部 family name、字号和 renderer 版本。libass 的官方指南规定这些 header、字体附件与 style 字段。下列内容只是事件 `Text` 字段示意，仍需完整的 `[V4+ Styles]`、`[Events]`。来源：[libass 文件格式指南](https://github.com/libass/libass/wiki/ASS-File-Format-Guide)。

| 覆盖点 | 官方语义及建议配方 |
| --- | --- |
| 定位标牌、层叠 | `\an7` 是左上锚点，`\pos(96,72)` 使用脚本坐标；自拟 `SIGN-A` 配底板。底板设事件 `Layer=0`，文字设 `Layer=1`，高层绘制在低层之上。来源：[Aegisub tags](https://aegisub.org/docs/latest/ass_tags/)、[Layer](https://aegisub.org/docs/latest/editing_subtitles/)。 |
| 矢量绘图、裁剪 | 原创底板可用 `\an7\pos(80,64)\bord0\shad0\p1` 后接 `m 0 0 l 240 0 240 72 0 72`，以 `\p0` 退出绘图。分别测试 `\clip(80,64,180,136)`、`\clip(m 80 64 l 320 64 80 136)` 和独立的 `\iclip` 事件；clip 坐标相对画面左上角。矩形 clip 可用 `\t` 动画，矢量 clip 不可。来源：[Aegisub 绘图与 clip](https://aegisub.org/docs/latest/ass_tags/)。 |
| 多行 | `{\an7\pos(80,160)\q2}FIRST\NSECOND`：`\q2` 关闭自动换行，文本中的大写 `\N` 强制换行。来源：[Aegisub 换行](https://aegisub.org/docs/latest/ass_tags/)。 |
| 旋转 | 固定 `\an5\pos(640,300)\org(640,300)`；分开测试 `\frz30`、`\frx20`、`\fry20`，再用 `\frz0\t(0,1000,\frz30)` 检查动画。角度是度，`\t` 时间是事件起点后的毫秒，`\org` 固定旋转中心。来源：[Aegisub rotation/transform](https://aegisub.org/docs/latest/ass_tags/)。 |
| Karaoke | 自拟 `A B`，主色/次色分别设红/绿：`\1c&H0000FF&\2c&H00FF00&`。比较 `{\k50}A{\k50}B` 与 `\kf50`/`\K50`、`\ko50` 版本；时长单位是百分之一秒，分别覆盖即时变色、从左到右扫色、高亮前去轮廓。来源：[Aegisub karaoke/colors](https://aegisub.org/docs/latest/ass_tags/)。 |

建议按事件相对 PTS +250 ms、+750 ms 观察颜色/扫色与旋转，断言目标区域、裁剪外空白、多行布局和层叠关系；截图比较需固定字体及渲染环境。每行只选一种定位和一种裁剪方式，避免重复或互斥 tag 导致 renderer 差异。后一约束来源：[Aegisub override 规则](https://aegisub.org/docs/latest/ass_tags/)。

## PGS/SUP：原创几何位图的最小生成配方

可行性判断来自解码器源码：可直接生成 palette-index 图案与 SUP 字节，无需取用电影帧、现成字幕或字体。当前 FFmpeg 注册的是 PGS decoder；SUP muxer 接收已有 PGS 段并包装时间戳，不能据此推导出 ASS/SRT → PGS 编码能力。来源：[codec 注册](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavcodec/allcodecs.c#L733)、[SUP muxer](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavformat/supenc.c#L29)。

下面是 decoder 对字段的读取方式，并非蓝光标准符合性声明。`u8/u16/u24/u32` 表示无符号位宽，多字节字段均大端。每段独立包装：`"PG" (50 47) | PTS:u32 | DTS:u32 | type:u8 | payload_length:u16 | payload`，头部共 13 字节，长度只计 payload；时间基为 1/90000 秒，DTS=0 被 demuxer 当作未指定。来源：[SUP demuxer](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavformat/supdec.c#L24)。

| 段 | payload 字段顺序与本配方取值 |
| --- | --- |
| PCS `0x16` | `video_w:u16, video_h:u16, frame_rate:u8, composition_no:u16, state:u8, palette_update:u8, palette_id:u8, object_count:u8`；每个 object 再接 `object_id:u16, window_id:u8, flags:u8, x:u16, y:u16`。取 1280×720、composition 递增、palette 0、一个 object 0、window 0、flags 0（无裁剪/forced）。起始 state=`0x80` 清空缓存，后续 normal=`0x00`。单 object PCS 长度 19。来源：[FFmpeg PCS](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavcodec/pgssubdec.c#L389)。 |
| WDS `0x17` | `count:u8`，再接 `window_id:u8, x:u16, y:u16, w:u16, h:u16`；一个窗口长度 10，覆盖同一 object。FFmpeg 当前跳过 WDS 内容；窗口字段由 VideoLAN 源码 `pg_decode_windows/pg_decode_window` 核对。frame-rate 高 4 位为编号，24 Hz 编号 2，因此上行可取 `0x20`；低 4 位填 0。来源：[FFmpeg WDS 分支](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavcodec/pgssubdec.c#L645)、[VideoLAN libbluray 1.5.0 官方源码包，pg_decode.c 与 bluray.h](https://download.videolan.org/pub/videolan/libbluray/1.5.0/libbluray-1.5.0.tar.xz)。 |
| PDS `0x14` | `palette_id:u8, version:u8`，再接若干 `index,Y,Cr,Cb,A`（各 u8）。取 id/version=0，index 0=`16,128,128,0`（透明），index 1=`235,128,128,255`（不透明白）；两条 entry 长度 12。PGS alpha 的方向与 ASS transparency 相反。来源：[FFmpeg palette](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavcodec/pgssubdec.c#L327)、[ASS alpha](https://aegisub.org/docs/latest/ass_tags/)。 |
| ODS `0x15` | `object_id:u16, version:u8, sequence:u8, object_data_length:u24, w:u16, h:u16, RLE`。id/version=0，单段 sequence=`0xC0`（首段+末段）；`object_data_length=4+RLE字节数`，payload 长度=`11+RLE字节数`。来源：[FFmpeg object](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavcodec/pgssubdec.c#L232)、[VideoLAN pg_decode_sequence_descriptor](https://download.videolan.org/pub/videolan/libbluray/1.5.0/libbluray-1.5.0.tar.xz)。 |
| END `0x80` | payload 长度 0，结束 display set 并触发输出。PGS 无显式结束时间；下一 PCS 的 object_count=0 加 END 清除画面。来源：[FFmpeg display/end](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavcodec/pgssubdec.c#L497)。 |

RLE：非零 byte 是一个该 index 的像素；`00 f [低长度byte] [index]` 中长度为 `f&3F`，若 `f&40` 则为 `((f&3F)<<8)|下一byte`，若 `f&80` 则随后读取 index，否则 index=0；`00 00` 为行结束。每行准确展开 w 个像素，每对象恰好 w×h；禁止截断 escape、跨行 run 或超长 payload。来源：[FFmpeg decode_rle](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavcodec/pgssubdec.c#L162)。

建议实例（仅配方，未生成/验证）：object 为 64×24、位置 (128,96)，透明外框、不透明白色内部。首末行各为 `00 40 40 00 00`（64 个透明像素 + EOL）；中间 22 行各为 `00 01 00 BE 01 00 01 00 00`（透明 1 + 白 62 + 透明 1 + EOL）。合计 RLE 208 字节，object_data_length=212，ODS payload=219；尺寸、坐标和窗口均在画面内。1 秒处按 `PCS → WDS → PDS → ODS → END` 写入，各段 PTS=90000、DTS=0、palette_update=0；3 秒处写长度 11 的空 PCS（相同画布、composition_no 增 1、state/palette_update=0、object_count=0）及 END，各段 PTS=270000。单段对象保持在 u16 payload 长度以内；本配方不覆盖对象分片、forced、cropping 或 palette 动画。

## FFmpeg 封装与证据口径

Matroska 将该 codec 映射为 `S_HDMV/PGS`，当前 muxer 自动插入 `pgs_frame_merge`，后者合并至 END 的全部段；完整 display set 必须有 END。来源：[codec mapping](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavformat/matroska.c#L76)、[自动插入](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavformat/matroskaenc.c#L3629)、[filter 说明](https://ffmpeg.org/ffmpeg-bitstream-filters.html#pgs_005fframe_005fmerge)。

供主任务采用的命令示意，假设视频从 PTS=0 开始且长于 3 秒；本次没有执行：

```sh
ffmpeg -copyts -i generated-video.mkv -f sup -i generated.sup \
  -map 0:v:0 -map 1:s:0 -c copy -avoid_negative_ts disabled generated-pgs.mkv
```

`-c copy` 保留压缩字幕，不发生文本转位图；`-copyts` 保留输入起点，避免把首个字幕时间重置为零，muxer 仍可能调整时间，最终应核对 1 秒显示与 3 秒清除。来源：[FFmpeg streamcopy](https://ffmpeg.org/ffmpeg.html#Streamcopy)、[copyts](https://ffmpeg.org/ffmpeg.html#Advanced-options)。

PGS 仍须独立实现并验证：段长度/像素数、解码无错误、封装后 codec/PTS、真实 macOS 播放时位置/透明边缘/清除，以及字幕开关与 seek 后状态。合成 fixture 通过只证明这些生成样本在记录的环境中通过；真实影片复杂排版、其他字幕格式/容器、全格式兼容性和人类观感验收仍需单独证据。轨道枚举、ffprobe 或 remux 成功不能替代画面验收。研究及后续验收未修改既有 `BUILTIN_PLAYBACK_RESEARCH.md`、git/index、issues 或个人媒体库，未安装依赖。

## 已执行的 macOS ASS 与远程外挂检查

2026-10-03，macOS arm64 开发环境；不是签名安装包或干净机器。生成的 `complex.ass` 使用系统 Arial/中文回退字体，没有固定/嵌入字体附件，因此不声明跨字体的严格像素一致性。测试固定暂停位置，开关字幕，读取同一原生渲染面的像素；未通过 renderer 传输影片帧或本机外挂路径。

本机 `node scripts/playback-subtitle-acceptance.mjs` 正常退出 0、无强制终止：五个 ASS 事件均被封装并及时可读，六种预期颜色及四个象限有不同像素；裁剪后绿/青矢量面积比约 0.598，独立预期为 `60×50 / (120×42)`。同几何下暂停定位 4→16 秒，卡拉 OK 黄色像素 3764→11924，红色相应减少；不是只读一个已选轨道。展开/底栏/全屏均保持同会话、暂停及一次加载，字号禁用、延迟 0.5 秒/重置的真实控件状态通过；全屏字幕下沿 1862px，控制条起点 2000px。

`node scripts/playback-remote-acceptance.mjs --media-matrix --system-subtitle-picker` 以同源码的独立 Node 宿主、隔离资料库运行，正常退出 0、无强制终止。先验证内嵌复杂 ASS，再真实打开两次 macOS 文件选择器，分别选择生成的 `external.srt` 和 `complex.ass`，没有替换 `showOpenDialog` 或用 IPC 提交任意路径。SRT 的纯文本字号 40、ASS 自带样式及各自展开/底栏/全屏原生像素通过，暂停位置/会话/一次加载保持；全屏 SRT 下沿 1874px，ASS 下沿 1862px，均位于 2000px 控件起点上方。三部影片共三次 grant，外挂操作未增加 grant；远程模式未创建本机资料库，默认关闭未写续播文件。这里只核对授权次数与投影路径边界，未声称清除 OS 最近选择器目录或服务器必要日志。

首轮像素检查确实失败：最后一条 PTS=0 对白被 FFmpeg 稀疏流交错排在约 25.8 秒视频之后。只调整合成素材生成的 `-max_interleave_delta 0`，并用 ffprobe 检查全部五条事件位于 4 秒比较帧前；未为了测试修改播放器的解码/缓存策略。0 的含义是继续等待各流包，而不是按默认时间差提前刷出，依据 [FFmpeg format options](https://ffmpeg.org/ffmpeg-formats.html#Format-Options)。另尝试独立 FFmpeg 字幕滤镜，但当前 CLI 构建无该滤镜，**没有独立滤镜渲染通过证据**；通过的是应用自己的 libmpv 原生渲染回归。

可复查的生成输入、摘要/ffprobe 清单、`subtitle-report.json` 与原生帧在 `out/playback-acceptance/media-matrix/`，远程结果在 `out/playback-acceptance/remote-media-report.json`。它们是被打包排除的验收生成物，不作为产品素材；报告会随后续同命令重跑更新，以上 ASS/选择器结果为对应历史运行。原创几何 PGS 的后续检查见另文，不能外推为全部图像字幕通过；对象分片、其它图像字幕格式、动画裁剪、字体附件/丢字、真实长片、异机网络及人工音画等仍未验收。

修正素材后重跑完整 `node scripts/playback-media-acceptance.mjs`：13 组检查通过，正常退出 0、未强制终止，包括原有多音轨、普通 ASS、章节、Main10、无音轨、倍速、三种比例及新增复杂 ASS。`npm run test:packaging` 16/16 通过、0 跳过，继续确认这些输出目录不会进入安装包；不是安装包本身或全量 `npm test` 的本轮重验。用于区分 stream-copy 与交错行为的两个临时 MKV 已移入 `out/playback-acceptance/subtitle-diagnostics/`，不属于素材清单，没有删除个人数据或其它在途进程。
