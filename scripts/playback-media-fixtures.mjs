// Synthetic SDR fixtures, not copyrighted movies or a distributable runtime.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { output } from './playback-acceptance-support.mjs'
import { bitmapFixture, createPgsFixture } from './playback-pgs-fixture.mjs'

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,26,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:36.00,Default,,0,0,0,,ASS styled subtitle\n`
const srt = '1\n00:00:00,000 --> 00:00:36,000\nExternal SRT subtitle\n'
// Independent signs, clipped vector art, layered dialogue and karaoke exercise
// ASS composition without relying on a movie, an embedded font or HTML overlays.
const complexAss = String.raw`[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,1,0,2,18,18,18,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:36.00,Default,,0,0,0,,{\an7\pos(55,45)\bord0\shad0\1c&HFFFF00&\p1}m 0 0 l 120 0 120 42 0 42{\p0}
Dialogue: 1,0:00:00.00,0:00:36.00,Default,,0,0,0,,{\an7\pos(430,45)\frz-12\fs18\1c&HFF00FF&}POSITIONED SIGN
Dialogue: 2,0:00:00.00,0:00:36.00,Default,,0,0,0,,{\an7\pos(430,140)\clip(430,140,490,190)\bord0\shad0\1c&H00FF00&\p1}m 0 0 l 120 0 120 50 0 50{\p0}
Dialogue: 3,0:00:00.00,0:00:36.00,Default,,0,0,0,,{\an5\pos(290,230)\1c&H00FFFF&\2c&H0000FF&}{\kf1200}Karaoke {\kf1200}timing {\kf1200}check
Dialogue: 4,0:00:00.00,0:00:36.00,Default,,0,0,0,,Multiline ASS dialogue\N本机外挂 / Remote subtitle
`
const chapters = ';FFMETADATA1\n' + ['Opening', 'Middle', 'Ending'].map((title, index) =>
  `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${index * 12000}\nEND=${(index + 1) * 12000}\ntitle=${title}\n`).join('\n')
const base = 'h264-aac.mp4', multi = 'multi-audio-ass-chapters.mkv', hevc = 'hevc-main10.mkv', silent = 'no-audio.mp4'
const complex = 'complex-ass.mkv'
const bitmap = 'bitmap-pgs.mkv'
// White borders make the displayed image rectangle measurable independently of
// the renderer/view dimensions. Anamorphic pixels must not be treated as square.
const aspects = [
  { file: 'anamorphic.mp4', width: 720, height: 576, sar: '64/45', display: '16:9' },
  { file: 'portrait.mp4', width: 360, height: 640, sar: '1/1', display: '9:16' },
  { file: 'ultrawide.mp4', width: 640, height: 270, sar: '1/1', display: '64:27' }
]
const plans = [
  [base, ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '36', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=Main', '-movflags', '+faststart']],
  [multi, ['-i', base, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
    '-i', 'styled.ass', '-f', 'ffmetadata', '-i', 'chapters.ffmeta', '-map', '0:v', '-map', '0:a', '-map', '1:a', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-map_chapters', '4', '-t', '36', '-c:v', 'copy', '-c:a:0', 'copy',
    '-c:a:1', 'ac3', '-ac:a:1', '6', '-b:a:1', '384k', '-c:a:2', 'eac3', '-ac:a:2', '6', '-b:a:2', '384k',
    '-c:a:3', 'dca', '-strict:a:3', '-2', '-ac:a:3', '2', '-b:a:3', '768k', '-c:s', 'ass',
    '-metadata:s:a:0', 'title=Main', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'title=Dub', '-metadata:s:a:1', 'language=jpn',
    '-metadata:s:a:2', 'title=Commentary', '-metadata:s:a:2', 'language=fra', '-metadata:s:a:3', 'title=Alternate', '-metadata:s:a:3', 'language=deu',
    '-metadata:s:s:0', 'title=Styled', '-metadata:s:s:0', 'language=eng',
    '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', '0', '-disposition:a:3', '0', '-disposition:s:0', 'default']],
  [hevc, ['-i', base, '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
    '-x265-params', 'log-level=error:pools=2:frame-threads=2', '-c:a', 'copy']],
  [silent, ['-i', base, '-map', '0:v', '-c', 'copy', '-an', '-movflags', '+faststart']],
  ...aspects.map(({ file, width, height, sar }) => [file, ['-f', 'lavfi', '-i',
    `color=white:size=${width}x${height}:rate=24,drawbox=x=100:y=100:w=80:h=80:color=red:t=fill,setsar=${sar}`,
    '-t', '36', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart']]),
  [complex, ['-f', 'lavfi', '-i', 'color=c=0x202020:size=640x360:rate=24', '-i', 'complex.ass',
    '-map', '0:v', '-map', '1:s', '-t', '36', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:s', 'ass', '-max_interleave_delta', '0', '-metadata:s:s:0', 'title=Complex', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default']],
  [bitmap, ['-copyts', '-i', complex, '-f', 'sup', '-i', 'bitmap.sup', '-map', '0:v:0', '-map', '1:s:0',
    '-c', 'copy', '-avoid_negative_ts', 'disabled', '-max_interleave_delta', '0',
    '-metadata:s:s:0', 'title=Bitmap', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default']]
]
const hash = value => createHash('sha256').update(value).digest('hex')
function run(command, args, directory) {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`)
  return result.stdout
}

// Independent FFmpeg PGS decode through sub2video/overlay: no libass filter is
// needed. Check every pixel at safe display/clear times, not only stream metadata.
function verifyBitmapDecode(directory) {
  const { canvas, object, cues } = bitmapFixture
  const filter = '[0:v:0][0:s:0]overlay,select=eq(n\\,48)+eq(n\\,96)+eq(n\\,288)+eq(n\\,528)'
  const args = ['-v', 'error', '-i', bitmap, '-filter_complex', filter, '-frames:v', '4', '-fps_mode', 'passthrough']
  const decoded = spawnSync('ffmpeg', [...args, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { cwd: directory, maxBuffer: 8 * 1024 * 1024 })
  if (decoded.error) throw decoded.error
  assert.equal(decoded.status, 0, `independent PGS decode failed: ${decoded.stderr}`)
  assert.equal(decoded.stderr.length, 0, 'PGS reference decode must not log errors')
  const frameSize = canvas.width * canvas.height * 4
  assert.equal(decoded.stdout.length, frameSize * 4)
  const evidence = []
  for (const [index, cue] of [cues[0], null, cues[1], null].entries()) {
    let white = 0
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const ox = x - (cue?.x ?? 0), oy = y - (cue?.y ?? 0), { border, hole } = object
      const expected = Boolean(cue && ox >= border && ox < object.width - border && oy >= border && oy < object.height - border
        && !(ox >= hole.x && ox < hole.x + hole.width && oy >= hole.y && oy < hole.y + hole.height))
      const offset = index * frameSize + (y * canvas.width + x) * 4
      const pixel = decoded.stdout.subarray(offset, offset + 3)
      assert.ok(expected ? pixel.every(value => value > 220) : pixel.every(value => value >= 20 && value <= 40),
        `PGS reference frame ${index}, pixel ${x},${y}: expected ${expected ? 'white' : 'uncovered gray'}`)
      if (expected) white++
    }
    assert.equal(white, cue ? 3648 : 0)
    evidence.push({ seconds: [2, 4, 12, 22][index], whitePixels: white })
  }
  run('ffmpeg', ['-y', ...args, 'bitmap-reference-%02d.png'], directory)
  return evidence
}

export function prepareMediaFixtures() {
  const directory = path.join(output, 'media-matrix')
  fs.mkdirSync(directory, { recursive: true })
  const version = run('ffmpeg', ['-version'], directory).split('\n')[0]
  const pgs = createPgsFixture()
  const signature = hash(JSON.stringify({ version, ass, srt, complexAss, chapters, pgs: hash(pgs), plans }))
  const manifestFile = path.join(directory, 'fixtures.json')
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { /* New fixture run. */ }
  const reusable = manifest?.signature === signature && plans.every(([file]) => fs.existsSync(path.join(directory, file))
    && hash(fs.readFileSync(path.join(directory, file))) === manifest.files?.[file]?.sha256)
  for (const [file, content] of [['styled.ass', ass], ['external.srt', srt], ['complex.ass', complexAss], ['chapters.ffmeta', chapters]]) fs.writeFileSync(path.join(directory, file), content)
  fs.writeFileSync(path.join(directory, 'bitmap.sup'), pgs)
  if (!reusable) for (const [file, args] of plans) run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args, file], directory)
  const files = Object.fromEntries(plans.map(([file]) => [file, {
    sha256: hash(fs.readFileSync(path.join(directory, file))),
    probe: JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_chapters', '-show_format', '-of', 'json', file], directory))
  }]))
  const streams = files[multi].probe.streams
  assert.deepEqual(streams.filter(stream => stream.codec_type === 'audio').map(stream => [stream.codec_name, stream.channels]),
    [['aac', 2], ['ac3', 6], ['eac3', 6], ['dts', 2]])
  assert.equal(streams.find(stream => stream.codec_type === 'subtitle').codec_name, 'ass')
  assert.deepEqual(files[multi].probe.chapters.map(chapter => [chapter.tags?.title, Number(chapter.start_time)]),
    [['Opening', 0], ['Middle', 12], ['Ending', 24]])
  assert.equal(files[hevc].probe.streams[0].profile, 'Main 10')
  assert.equal(files[hevc].probe.streams[0].pix_fmt, 'yuv420p10le')
  assert.equal(files[silent].probe.streams.filter(stream => stream.codec_type === 'audio').length, 0)
  assert.equal(files[complex].probe.streams.find(stream => stream.codec_type === 'subtitle').codec_name, 'ass')
  // Validate the generated media, not just its source ASS. A sparse stream's
  // last event can otherwise be muxed after 25s of video despite having PTS 0.
  const packets = JSON.parse(run('ffprobe', ['-v', 'error', '-show_packets', '-of', 'json', complex], directory)).packets
  const subtitlePackets = packets.flatMap((packet, index) => packet.codec_type === 'subtitle' ? [{ packet, index }] : [])
  assert.equal(subtitlePackets.length, 5, 'all five complex ASS events must survive muxing')
  assert.ok(subtitlePackets.every(({ packet, index }) => Number(packet.pts_time) === 0
    && index < packets.findIndex(packet => packet.codec_type === 'video' && Number(packet.pts_time) >= 4)),
    'all ASS layers must be available before the comparison frame, not arrive after it')
  assert.equal(files[bitmap].probe.streams.find(stream => stream.codec_type === 'subtitle').codec_name, 'hdmv_pgs_subtitle')
  assert.deepEqual([files[bitmap].probe.streams[0].width, files[bitmap].probe.streams[0].height],
    [bitmapFixture.canvas.width, bitmapFixture.canvas.height])
  const bitmapPackets = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 's', '-show_packets', '-of', 'json', bitmap], directory)).packets
  assert.deepEqual(bitmapPackets.map(packet => Number(packet.pts_time)), bitmapFixture.cues.flatMap(cue => [cue.start, cue.end]),
    'PGS display/clear timestamps must survive stream copy')
  for (const { file, width, height, sar, display } of aspects) {
    const video = files[file].probe.streams.find(stream => stream.codec_type === 'video')
    assert.deepEqual([video.width, video.height, video.sample_aspect_ratio, video.display_aspect_ratio],
      [width, height, sar.replace('/', ':'), display], `${file} aspect metadata`)
  }
  const bitmapReference = verifyBitmapDecode(directory)
  fs.writeFileSync(manifestFile, JSON.stringify({ version, signature, files, bitmapReference }, null, 2))
  const names = [multi, hevc, silent, base, ...aspects.map(item => item.file), complex, bitmap]
  return { directory, files, version, aspects, complexIndex: names.indexOf(complex),
    bitmapIndex: names.indexOf(bitmap), bitmapFixture, bitmapReference,
    media: names.map(file => path.join(directory, file)) }
}
