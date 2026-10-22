import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const [binary,directory]=process.argv.slice(2)
assert(binary&&directory,'Usage: node scripts/linux-load-fixtures.mjs FFMPEG NEW_DIRECTORY')
fs.mkdirSync(directory)
const plans=[
 ['h264-4k60',60,['-c:v','libx264','-preset','ultrafast','-crf','26','-threads','4','-pix_fmt','yuv420p']],
 ['hevc-main10-4k60',60,['-c:v','libx265','-preset','ultrafast','-crf','28','-x265-params','pools=4:frame-threads=2:log-level=error','-pix_fmt','yuv420p10le']],
 ['av1-4k30',30,['-c:v','libaom-av1','-cpu-used','8','-row-mt','1','-threads','4','-crf','40','-pix_fmt','yuv420p']]
]
const manifest={ffmpeg:path.resolve(binary),toolSha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),cases:[]}
for(const [name,fps,encode]of plans){
 const seed=path.join(directory,name+'-seed.mkv'),file=path.join(directory,name+'.mkv')
 const args=['-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc2=size=3840x2160:rate=${fps},drawbox=x=iw-240:y=40:w=160:h=160:color=white:t=fill:enable='lt(mod(t,5),0.1)'`,'-f','lavfi','-i','aevalsrc=if(lt(mod(t\\,5)\\,0.1)\\,0.25*sin(2*PI*880*t)\\,0):s=48000','-t','10',...encode,'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a','pcm_s16le','-n',seed]
 const r=spawnSync(binary,args,{encoding:'utf8',timeout:600000});assert.equal(r.status,0,r.stderr)
 const loop=spawnSync(binary,['-hide_banner','-loglevel','error','-stream_loop','7','-i',seed,'-c','copy','-n',file],{encoding:'utf8',timeout:120000});assert.equal(loop.status,0,loop.stderr)
 manifest.cases.push({name,file:path.resolve(file),width:3840,height:2160,fps,seconds:80,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),args})
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2))
}
