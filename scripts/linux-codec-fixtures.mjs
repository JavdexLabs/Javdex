// Uses a caller-provided FFmpeg; never installs packages or modifies source media.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const [binary, destination] = process.argv.slice(2)
assert(binary && destination, 'Usage: node scripts/linux-codec-fixtures.mjs /absolute/ffmpeg NEW_DIRECTORY')
const ffmpeg=path.resolve(binary), output=path.resolve(destination)
fs.mkdirSync(output)
const plans=[
  ['h264-1080p30.mp4',70,['-c:v','libx264','-preset','ultrafast','-crf','24','-threads','4','-pix_fmt','yuv420p','-c:a','aac']],
  ['hevc-main10-1080p30.mkv',12,['-c:v','libx265','-preset','ultrafast','-x265-params','pools=4:frame-threads=2:log-level=error','-pix_fmt','yuv420p10le','-c:a','aac']],
  ['av1-1080p30.mkv',12,['-c:v','libaom-av1','-cpu-used','8','-row-mt','1','-threads','4','-crf','40','-pix_fmt','yuv420p','-c:a','libopus']]
]
const manifest={ffmpeg,toolSha256:createHash('sha256').update(fs.readFileSync(ffmpeg)).digest('hex'),media:[]}
for(const [name,seconds,encoding] of plans) {
  const args=['-hide_banner','-loglevel','error','-f','lavfi','-i',"testsrc2=size=1920x1080:rate=30,drawbox=x=iw-160:y=40:w=120:h=120:color=white:t=fill:enable='lt(mod(t,5),0.1)'",'-f','lavfi','-i',"aevalsrc=if(lt(mod(t\\,5)\\,0.1)\\,0.35*sin(2*PI*880*t)\\,0):s=48000",'-t',String(seconds),...encoding,'-n',path.join(output,name)]
  const result=spawnSync(ffmpeg,args,{stdio:'inherit',timeout:600000})
  assert.equal(result.status,0,String(result.error || 'FFmpeg failed'))
  fs.writeFileSync(path.join(output, name.replace(/\.[^.]+$/, '.srt')), '1\n00:00:00,000 --> 00:00:04,000\nJAVDEX hardware subtitle ONE\n\n2\n00:00:04,000 --> 00:01:10,000\nJAVDEX hardware subtitle TWO\n')
  manifest.media.push({name,args,sha256:createHash('sha256').update(fs.readFileSync(path.join(output,name))).digest('hex')})
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2))
}
