#!/usr/bin/env node
// Public, synthetic acceptance media. No personal media or network input.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const directory = path.resolve(process.argv[2] ?? 'out/cpu-playback-acceptance')
fs.mkdirSync(directory, { recursive: true })
const source = path.join(directory, 'cpu-720p30-h264-aac.mp4')
const subtitle = path.join(directory, 'acceptance.srt')
fs.writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:59,900\nCPU FRAME ACCEPTANCE: embedded subtitle\n')
const args = ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=60',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60',
  '-i', subtitle, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:s:0',
  '-vf', 'drawbox=x=0:y=0:w=100:h=100:color=red:t=fill,drawbox=x=1180:y=0:w=100:h=100:color=lime:t=fill,drawbox=x=0:y=620:w=100:h=100:color=blue:t=fill,drawbox=x=1180:y=620:w=100:h=100:color=yellow:t=fill',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-threads', '2', '-pix_fmt', 'yuv420p',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
  '-movflags', '+faststart', source]
const encode = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 180000 })
if (encode.error) throw encode.error
assert.equal(encode.status, 0, encode.stderr)
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], { encoding: 'utf8' })
assert.equal(probe.status, 0, probe.stderr)
const info = JSON.parse(probe.stdout)
const video = info.streams.find(stream => stream.codec_type === 'video')
assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1280); assert.equal(video.height, 720)
assert.equal(video.avg_frame_rate, '30/1')
assert.equal(info.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac')
const evidence = { fileName: path.basename(source), bytes: fs.statSync(source).size,
  sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
  ffmpeg: spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0],
  generation: args.map(value => value === source || value === subtitle ? path.basename(value) : value),
  streams: info.streams.map(({ codec_name, codec_type, width, height, avg_frame_rate, sample_rate, channels, color_transfer }) =>
    ({ codec_name, codec_type, width, height, avg_frame_rate, sample_rate, channels, color_transfer })),
  duration: Number(info.format.duration),
  cornerColors: { topLeft: 'red', topRight: 'green', bottomLeft: 'blue', bottomRight: 'yellow' },
  license: 'Synthetic test pattern, generated locally with FFmpeg. No external media input.' }
fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
