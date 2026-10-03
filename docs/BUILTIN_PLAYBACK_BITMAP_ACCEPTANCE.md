# 内置播放：macOS PGS 位图字幕验收合同

研究日期：2026-10-03。以下研究章节只读核对配置和一手资料，不是运行证据；主任务后续实际检查单列在最后一节。PGS/SUP 字节配方沿用 [合成字幕 fixture 依据](BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md)，这里不重复段布局研究。源码比较基线固定为 [mpv v0.41.0 / 41f6a645](https://github.com/mpv-player/mpv/tree/41f6a645068483470267271e1d09966ca3b9f413) 与该配方使用的 [FFmpeg 98e92563](https://github.com/FFmpeg/FFmpeg/tree/98e92563a3b60dbf6d370fd3491d7f896398e4c1)；它们不是本机实际加载的 dylib/CLI 版本证明。

## 当前配置与位置、缩放依据

**当前实现观察**：[macPlayback.mm 的初始化 options](../apps/desktop/src/main/player/native/macPlayback.mm#L427) 设置 `config=no`、`vo=libmpv`、`pause=yes`、`sub-auto=no`，没有显式设置 `sub-pos`、`sub-scale`、`sub-ass-override`、`stretch-image-subs-to-screen` 或 `image-subs-video-resolution`。因此不能把“保留 PGS 原位置”的意图写成这些选项已经被应用强制固定；运行时还需记录有效值。本节没有审计其他调用方的运行时设置。

**上游证据**：比较基线的主字幕默认值是 `sub-pos=100`、`sub-scale=1`、`sub-ass-override=scale`；两个 image-subs 开关默认关闭。来源：[mpv options 默认值及注册](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/options/options.c#L299)、[主字幕共享默认值](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/options/options.c#L401)。

PGS 使用解码器给出的画布和对象坐标；普通 PGS 走保持比例的 letterbox 路径，`stretch-image-subs-to-screen=yes` 则先清除视频边缘 margin，`image-subs-video-resolution=yes` 则用视频尺寸覆盖字幕画布。来源：[mpv PGS 与画布处理](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/sub/sd_lavc.c#L478)。像素缩放按去掉 margin 的区域计算，位置再加回 margin，并分别取整矩形两端。来源：[osd_rescale_bitmaps](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/sub/osd.c#L538)。

ASS 命名不意味着只影响文字：override 开启时，`sub-pos=p` 只移动对象起点在画布下半部的位图，先减去 `(100-p)/100 × canvasHeight`，再限制在画布内；上半部对象不动。`sub-scale=q` 在上述位置换算之后，围绕每个对象中心缩放显示宽高；override 为 `no` 时跳过这两项覆盖。来源：[mpv bitmap override 条件与变换](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/sub/sd_lavc.c#L510)。例如画布高 360、对象 y=260、p=90 时，上移约 36 个源像素；原配方 y=96 不会覆盖这条移动分支。

**验收推导**：以下按视频与 PGS 画布均为 640×360、方形像素、无旋转/裁剪/zoom 计算；640×360 是画布，位图对象实际 `(x,y,w,h)` 和透明边框宽度由生成清单提供。若匹配视频的实际显示矩形是 `(L,T,W,H)`，默认几何约为 `s=W/640≈H/360`、对象左上角 `(L+s*x,T+s*y)`、大小 `(s*w,s*h)`。测量应使用原生渲染面物理像素和实际视频矩形，不使用整个窗口的宽高；记录 backing scale 和图像原点。重新布局后重新计算，不能复用旧坐标。取整及缩放滤波允许边缘带差异，不允许把字幕拉伸到黑边、产生不透明底板或改变对象的相对位置。上述公式只适用于匹配画布的这个小样本，不外推到错配画布、变形像素或全部 PGS。

## 选轨、重选与暂停精确 seek

**上游证据**：写入当前已选的同一轨道会直接返回；实际切换会卸载旧字幕解码器并初始化新解码器。字幕选轨请求从当前时间之前 10 秒刷新 demux；暂停时初始化会等待包，短暂等待未就绪后交回播放循环继续处理。来源：[同轨 no-op 与切轨](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/player/loadfile.c#L677)、[选轨回读起点](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/player/loadfile.c#L360)、[暂停重建](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/player/sub.c#L218)。

PGS 解码结果本身没有有限结束时间，下一显示事件可以是空画面。来源：[FFmpeg display_end](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/libavcodec/pgssubdec.c#L510)。mpv 在接收下一事件时结束上一事件，空事件不再生成可见对象；reset 清空位图队列并 flush 解码器。来源：[mpv 结束旧事件](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/sub/sd_lavc.c#L371)、[reset](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/sub/sd_lavc.c#L620)。因此重建依赖重新取得所需的字幕数据，不能把旧截图或轨道枚举当作证据。

`seek <t> absolute+exact` 要求精确定位，但字幕恢复仍受 demux 回读影响。官方手册明确限制 Matroska 字幕 preroll 的可靠性；比较源码的普通回读默认 1 秒，具有 duration index 时另有 10 秒范围，并按索引/cluster 选择起点。来源：[mpv seek](https://mpv.io/manual/master/#command-seek)、[preroll 限制](https://mpv.io/manual/master/#options-demuxer-mkv-subtitle-preroll)、[默认范围](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/demux/demux_mkv.c#L260)、[cluster 选择](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/demux/demux_mkv.c#L3420)。

**测试设计推导**：第二 cue 从 8 秒持续至 20 秒，冷状态 seek 到 16/19 秒尤其需要单独检查；长 cue 起点可能落在实际回读范围之外。先从 8 秒之前取得显示状态再成功，不能替代冷 seek 成功。若默认配置失败，应记录限制、容器索引及有效 preroll 参数；额外回读参数或补充 seek 的诊断结果必须另列，不算默认产品行为通过。同样，`sub-visibility=no/yes` 保留选择和解码，不能替代 `sid=no → PGS ID` 的重建检查。来源：[mpv visibility 与 sid 语义](https://mpv.io/manual/master/#options-sub-visibility)、[sid](https://mpv.io/manual/master/#options-sid)。

## 原创 640×360 小样本的验收预期

合成视频需从 PTS=0 开始并长于 21 秒；白色图案和透明外框为原创。预期显示区间为 `[1,3)`、`[8,20)`，3/20 秒均有明确清除事件。以下是待验证预期，不是已通过结果。

| 检查 | 必须观察到的画面与状态 |
| --- | --- |
| 从头顺序解码/播放 | 0.5 秒无位图；2 秒首 cue；4 秒清空；9、16 秒第二 cue；21 秒清空。不能用视频 EOF 自动消失证明 20 秒清除。 |
| 暂停选轨/重选 | 在 2、9 秒分别 `sid=no → 实际 PGS ID`，出现正确白色区域；再关轨清空、再选恢复。维持 pause 和目标 PTS，不重新加载媒体。仅重复写相同 ID 不算重选。 |
| 暂停精确 seek | 逐项完成 `2 → 4 → 9 → 21 → 2`，核对可见/清空及倒退重建；另外单列冷 seek 到 16/19 秒，核对长 cue 的恢复。 |
| letterbox 与展示模式 | 展开、底栏、全屏各以实际视频矩形预测位置、尺寸；固定 cue/PTS，观察白色内部、透明外框和字幕关闭时同一底图的差异。 |
| 几何选项覆盖 | 记录 `sub-pos/sub-scale/sub-ass-override` 有效值。若加测 p/q，按上节条件预期；上半部对象只能证明 sub-pos 不移动该对象，不能证明下半部覆盖分支。 |

等待规则：seek 后确认属于该次操作的完成信号、目标 PTS、pause 保持，以及新原生画面已经提交，再取像素。`MPV_EVENT_PLAYBACK_RESTART` 是 seek 请求完成的检测信号，仍不独自证明字幕像素已经呈现。来源：[libmpv 事件合同](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/include/mpv/client.h#L1337)。选轨也应等待画面就绪，不能把异步请求被接收或固定短暂 sleep 当成重建完成。

透明边框应在未缩放的独立解码中保留底图；原生缩放时允许滤波边缘带，比较白色内部及确定 alpha=0 的外侧区域。黑色底图无法单独区分透明与不透明黑边，需选择边框下有颜色的区域或检查解码 alpha。逐帧同 PTS 的字幕开/关差异比全屏白像素总数更有辨识力。只在安全的 cue 内部时刻取主断言；若加测 1/3/8/20 秒边界，须记录实际帧 PTS 和容器精度。

## 无 ass/subtitles 滤镜时的独立 FFmpeg 检查

**一手可行性证据**：FFmpeg 允许把 bitmap subtitle stream 接到视频滤镜输入，这是官方注明的实验性兼容路径；不需要 libass 的 `ass`/`subtitles` 滤镜。来源：[FFmpeg filter_complex 位图例外](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/doc/ffmpeg.texi#L2804)。`sub2video` 创建零填充画布，按 rectangle 的位置把 palette 像素复制进去；无 rectangle 的事件生成空画布。来源：[FFmpeg 画布与拷贝](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/fftools/ffmpeg_filter.c#L288)、[事件更新](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/fftools/ffmpeg_filter.c#L359)。

供主任务执行的示意；本次没有执行。先检查 CLI 的 PGS decoder、`overlay/fps/select/format` 和 PNG encoder 是否可用，输出到隔离的生成物目录。输入假设为只有一个 PGS 字幕流的 640×360 视频，PTS=0，时长至少 22 秒；实际流号按素材清单替换。

```sh
ffprobe -v warning -select_streams s:0 -show_frames -of json generated-pgs.mkv

ffmpeg -hide_banner -loglevel verbose -xerror -n \
  -canvas_size 640x360 -i generated-pgs.mkv \
  -filter_complex "[0:v:0][0:s:0]overlay=x=0:y=0:format=rgb:eof_action=repeat:shortest=0:repeatlast=1,fps=2,select='eq(n,1)+eq(n,4)+eq(n,8)+eq(n,18)+eq(n,32)+eq(n,42)',format=rgb24[out]" \
  -map "[out]" -an -t 22 -fps_mode passthrough -c:v png independent-%02d.png
```

**命令推导与判读**：从开头解码，不加输入 seek，保留 show_frames 的 SUBTITLE 时间/rectangle 数与解码日志；`show_frames` 可报告字幕，但没有像素证据。来源：[ffprobe show_frames](https://ffmpeg.org/ffprobe.html#Main-options)。2 fps 采样后六张图约对应 0.5、2、4、9、16、21 秒；确认实际 PTS/数量，按表检查区域，并与同 PTS 的无字幕底图比较。`canvas_size` 显式固定画布。来源：[FFmpeg canvas_size](https://github.com/FFmpeg/FFmpeg/blob/98e92563a3b60dbf6d370fd3491d7f896398e4c1/doc/ffmpeg.texi#L2284)、[fps/select](https://ffmpeg.org/ffmpeg-filters.html#fps)。

这里使用 repeat 保留最后字幕画布，包括明确的透明清除帧；`shortest=0` 让视频继续。不能只靠 `eof_action=pass`、`repeatlast=0` 或提前结束输出来证明清除时间。来源：[FFmpeg framesync](https://ffmpeg.org/ffmpeg-filters.html#Options-for-filters-with-several-inputs-_0028framesync_0029)。要求正常退出、无解码/越界/非位图告警、预期图像齐全且像素断言正确；缺少所需组件则记录未验证，不安装依赖或替换为 remux/stream-copy 成功。

这条路径独立于应用的 libmpv/OpenGL 集成，却可能共用 FFmpeg PGS 解码实现，不能证明蓝光标准符合性、另一解码器兼容性或应用 seek/布局通过。PNG overlay 也不直接保留原始字幕 alpha；透明性判据需同底图比较或另行保留 RGBA 字幕画布。白色几何小样本不覆盖复杂调色板、多个对象、分片、裁剪、forced、动画、HDR、其他容器、真实长片或安装包验收。

## 已执行检查：macOS arm64，partial-pass

主任务在 2026-10-03 实际生成并执行，使用现有开发 addon/运行库和隔离资料目录，未下载影片或安装依赖。正式分发库尚未固定；没有从 libmpv API 读取版本与全部有效几何/preroll 参数，不将上述源码版本或 CLI 版本冒充实际 dylib 版本/选项证明。

### 原创输入与独立解码

`scripts/playback-pgs-fixture.mjs` 生成 640×360 画布、128×40 位图，4px 透明外框、16×12 透明中心孔、其余白色；可见区域恰为 3648 个源像素。两次定位分别为 (96,64)、(256,294)，显示区间 `[1,3)`、`[8,20)`；两组独立 epoch 均含 palette/object，3/20 秒各有空 composition/END。这是小样本生成器，不是通用字幕编码器。

`npm run test:playback:fixtures` 3/3 通过：独立读取包装长度、时间戳、composition/window/palette 和 RLE 字节，逐像素核对固定图案。此命令不需要 FFmpeg、Electron GUI 或开发运行库；已纳入根 `npm test`。完整测试的最新结果见下，不以此三个 fixture 测试代替应用验收。

FFmpeg 9.0.2 将原创 SUP stream-copy 到灰色 H.264 MKV，ffprobe 核对 `hdmv_pgs_subtitle` 与 1/3/8/20 秒包。独立解码实际使用 `[0:v:0][0:s:0]overlay,select=eq(n\,48)+eq(n\,96)+eq(n\,288)+eq(n\,528)`，24fps 对应 2/4/12/22 秒，输出 RGBA 和 PNG；退出 0、error 日志为空，四帧白像素数为 3648/0/3648/0。所有其余像素均保留原灰底，包括外框和中心孔，不是只检查 codec 名称。输入/摘要/ffprobe 与 `bitmapReference` 在 `out/playback-acceptance/media-matrix/fixtures.json`，参考 PNG 为 `bitmap-reference-01.png` 至 `-04.png`。此路径与 libmpv 集成独立，但可能共用 FFmpeg 解码实现，不证明另一解码器或蓝光标准符合性。

### 确实复现的问题与受限修复

首次实际应用检查失败；增加有界像素就绪等待后，仍在部分暂停往返定位后的 `sid=no → PGS ID` 重选中出现白像素 0，等待 5 秒也未恢复。最小诊断去掉 ASS、自然播放和字幕延迟，仅保留一个 PGS 会话、2/4/12/22 秒往返和重选；21 次计划中的第 13 次重选失败，轨道已选、暂停/位置正确、`loadedFiles=1`、`commandErrors=0`。只做单一 12 秒重选的三次小试没有复现，不能把它称为完整绿灯。

最初对照在选轨反馈后补同位置 exact seek，21 次切换通过；但第一次实现把选轨与刷新同时发出，不能等价于该对照。较完整本机素材回归随后在回跳 2 秒时发现第二 cue 的位置；增强到具体 cue 几何的诊断还捕获到目标 4 秒、实际时钟约 10.417 秒且定位未完成，5 秒后仍未恢复。此前只断言白像素存在的 21 次结果不足以证明正确显示集，不能作为最终修复证据。

现已在 `PlaybackSession` 改为等待内核反馈目标轨道已选中，再进行受限刷新：仅主动选择尚未选中的 PGS、暂停、可定位且位置已知、不在续播选择/打开/结束阶段时安排。目标在选轨前保存，后续用户定位更新它，不能取重建期间的中间时钟；关闭/换字幕、恢复播放、停止或换影片取消旧刷新。等待选择及定位采用现有 20 秒失败上限，不保存重建中的时钟。不开启播放、不重载影片、不改字幕样式/隐藏语义、不增设 renderer 路径接口。播放中、关闭/已选轨道、ASS/音轨、不可定位/未知位置及续播待选择均不走刷新。

新的一变量对照（等已选轨反馈后定位）和产品修改后不额外补操作的 21 次往返均通过具体 cue/空画面的 64 个检查点，应用正常退出。永久像素回归同时等暂停意图、定位完成、目标时钟及预期 cue 的位置/尺寸，旧 cue 的白像素不再视为就绪；5 秒内不恢复仍失败，没有扩大坐标容差或补额外测试定位来掩盖错误。两项顺序/取消单位回归在修复前确实失败，修复后通过，并补充等待超时及进度保护。

上游选轨会卸载字幕解码器并重新回读，结合对照更支持选轨与定位时序导致显示集重建不正确，而不是错误 SUP 或隐藏的原生视图；**具体内核内部失效机制没有被源码级跟踪证明，不宣称修复了所有 mpv 版本**。相关一手路径见 [选轨](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/player/loadfile.c#L682)、[暂停重建](https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/player/sub.c#L215)。本次没有加入产品调试日志；临时诊断脚本、保留的失败/对照/修复后结果只在明确标记、打包排除的 `out/playback-acceptance/subtitle-diagnostics/`。初次完整素材回跳失败报告保留为 `media-before-geometry-readiness.json`，旧空字幕失败为 `pgs-toggle-before-fix.json`；重复诊断输出会覆盖同名文件，不承诺每次中间结果都有独立存档。

另一轮失败是像素边界 oracle 过严：亮像素宽度 498px，对连续比例公式的 501.33px 差 3.33px。位图矩形端点取整且边缘滤波后，亮像素边界不是完整矩形边界；测试现允许至多一个源像素（最小 3 个物理像素）的边缘带，同时保留独立解码逐像素、定位/尺寸、可见面积及透明孔/边框断言。不缩短 cue、不把空画面判为成功，也不改播放器几何来迎合素材。

### 实际原生画面

早期 `node scripts/playback-subtitle-acceptance.mjs` 复杂 ASS 与 PGS 两组通过，但之后较完整素材回归发现了上述时序问题；不能凭早期两组结果关闭问题。当前延后刷新实现与加强后的 pixel 就绪判据已重跑 `node scripts/playback-media-acceptance.mjs`，全部 14 组部分验收通过，退出 0、`cleanup.forced=false/code=0`，其中包含原始 PGS 场景和复杂 ASS、多音轨、Main10、章节、倍速及非标准比例的既有检查。

PGS 首次 seek 在全新播放会话的早期直跳 19 秒，显示第二 cue；此后自然时钟在第一 cue 显示前/显示中/清除后分别为空/可见/空。暂停 2→4→12→22→2 的显示、清除、倒退重建和重新选轨通过；0.5 秒延迟时 3.25 秒仍显示首 cue，重置后同时间为空，真实字号控件禁用。

展开/实时小视频底栏/全屏的实际 PNG 检查定位、尺寸和灰底透明性；第二 cue 亮像素数分别为 61540/1128/107220，四条外框中心和中心孔相对同 PTS 关闭字幕底图的 RGB 最大差均为 0。全屏亮区域下沿 1816px、全部差异下沿 1819px，原生控制条起点 2000px。始终保持同一 session、暂停位置及一次加载，默认关闭没有续播文件；停止后 native.alive=false，应用正常退出。当前完整素材报告为 `media-matrix/report.json` 的 `local-pgs` 组；`subtitle-report.json` 是此前单独运行的记录。主任务也实际查看了全屏 PNG。

针对会话的最新 26 项测试与相关来源/续播/音量/失败/播放入口合计 52 项通过。最新完整 `npm test` 退出 0：Electron 测试 3484 项中 3482 通过、2 跳过、0 失败；同一根命令的 PGS 字节 fixture 3/3、打包逻辑 16/16，以及全量 lint、类型与架构检查通过；桌面/服务端构建亦退出 0。测试分工是会话策略的单位回归加真实应用像素回归，不能由单位 fake 核心证明字幕已显示，也不是安装包验收。

### 远程原文件：实际执行结果

`npm run server:build` 后实际运行 `node scripts/playback-remote-acceptance.mjs --media-matrix`，独立 Node v22.23.2 宿主、隔离桌面/服务端目录与 loopback，8 组部分素材验收通过，应用正常退出（`forced=false/code=0`），页面异常为 0。最后一组用同一 PGS helper 验证首次 19 秒冷跳、自然显示/清除、暂停回跳、延迟/重置及展开/底栏/全屏的实际像素和透明区域，首 cue 与回跳的边界均为 `(462,285,499,131)`；全屏差异下沿 1819px，控制条起点 2000px。结束时仍为远程、暂停 12 秒，同一会话及一次加载；默认关闭未产生续播文件，远程模式未建立本机资料库。

四个实际打开的文件（多轨 ASS、HEVC、复杂 ASS、PGS）共 4 次播放授权，字幕重选/延迟/定位/形态切换没有再授权。实际流量计数为 11 次 Range 请求、11 次 206、85,580,633 字节排入服务端响应，活动请求最终为 0；这是发送侧计数，不等于全部字节被接收、逐字节 hash 或人类听感证据。服务端沿用原文件读取，未添加转码/转封装或本机字幕上传。报告为 `out/playback-acceptance/remote-media-report.json` 的 `remote-pgs` 组。

本次没有加 `--system-subtitle-picker`，因此新报告保留本机外挂选择器待验提示；此前真实系统选择器 SRT/ASS 结果另见 [字幕验收说明](BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md)，不能将未重跑该步骤说成再次通过。远程结果仍不是异机网络、Docker、真实长片或干净安装包验收。

仍未验证：冷 seek 16 秒的独立新会话、真实电影 PGS、多个对象/分片/裁剪/forced/调色板动画、DVD/DVB 等其它位图格式、错配画布、长片/人工音画、VoiceOver/多显示器、签名干净安装及其它平台。远程原文件读取和暂停刷新已有上述独立执行结果，不由本机结果外推，也不据此将完整 macOS 验收标为完成。
