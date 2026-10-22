import {pqCode as pq, hlgCode as hlg} from './linux-color-reference.mjs'
// Analytically generated YUV patches; no user media or system dependencies.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const [binary,directory]=process.argv.slice(2)
assert(binary&&directory,'Usage: node scripts/linux-color-fixtures.mjs FFMPEG NEW_DIRECTORY')
fs.mkdirSync(directory)
const width=1280,height=720
const levels=[0,0.02,0.08,0.22,0.5,0.75,0.94,1]
const nits=[0,0.1,1,10,50,100,400,1000]
const manifest={width,height,ffmpeg:path.resolve(binary),toolSha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),cases:[]}
for(const [name,full,trc,primaries,values] of [
 ['sdr-limited',false,'bt709','bt709',levels],['sdr-full',true,'bt709','bt709',levels],
 ['hdr10',false,'smpte2084','bt2020',nits.map(pq)],['hlg',false,'arib-std-b67','bt2020',nits.map(hlg)]
]) {
 const codes=values.map(v=>Math.round((full?0:64)+v*(full?1023:876)))
 const raw=Buffer.alloc(width*height*3)
 const colors=[[1,0,0],[0,1,0],[0,0,1],[0,1,1],[1,0,1],[1,1,0],[0.5,0.5,0.5],[1,1,1]]
 const encodedColors=colors.map(rgb=>rgb.map(v=>name.startsWith('sdr')?v:(name==='hdr10'?pq(100*v):hlg(100*v))))
 const kr=primaries==='bt709'?0.2126:0.2627,kb=primaries==='bt709'?0.0722:0.0593
 const yuv=encodedColors.map(([r,g,b])=>{const y=kr*r+(1-kr-kb)*g+kb*b;return [Math.round((full?0:64)+y*(full?1023:876)),Math.round(512+(b-y)/(2*(1-kb))*(full?1023:896)),Math.round(512+(r-y)/(2*(1-kr))*(full?1023:896))]})
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)raw.writeUInt16LE(y<height/2?codes[Math.floor(x/(width/8))]:yuv[Math.floor(x/(width/8))][0],2*(y*width+x))
 for(let plane=1;plane<=2;plane++)for(let y=0;y<height/2;y++)for(let x=0;x<width/2;x++){
  const value=y<height/4?512:yuv[Math.floor(x/(width/16))][plane]
  raw.writeUInt16LE(Math.max(0,Math.min(1023,value)),width*height*2+(plane-1)*width*height/2+2*(y*width/2+x))
 }
 const input=path.join(directory,name+'.yuv'),file=path.join(directory,name+'.mkv');fs.writeFileSync(input,raw)
 const args=['-hide_banner','-loglevel','error','-stream_loop','-1','-f','rawvideo','-pixel_format','yuv420p10le','-video_size',`${width}x${height}`,'-framerate','30','-i',input,'-t','12','-c:v','libx265','-preset','ultrafast','-x265-params','lossless=1:pools=2:frame-threads=1:log-level=error'+(name==='hdr10'?':master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1):max-cll=1000,400':''),'-color_range',full?'pc':'tv','-color_trc',trc,'-color_primaries',primaries,'-colorspace',primaries==='bt709'?'bt709':'bt2020nc','-n',file]
 const result=spawnSync(binary,args,{encoding:'utf8',timeout:120000});assert.equal(result.status,0,result.stderr)
 fs.unlinkSync(input)
 manifest.cases.push({name,file:path.resolve(file),trc,primaries,colors:name.startsWith('sdr')?colors:null,range:full?'full':'limited',codes,levels:name.startsWith('sdr')?levels:null,nits:name.startsWith('sdr')?null:nits,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),args})
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2))
}
