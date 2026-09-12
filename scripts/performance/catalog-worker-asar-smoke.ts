/** Starts a windowless Electron fixture, never the Javdex application or user catalog. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'
import { createPackageWithOptions } from '@electron/asar'
import { initDatabaseAtPath, closeDatabase } from '../../apps/desktop/src/main/db/database'

it('loads the built catalog worker and native SQLite from an ASAR in real Electron', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-worker-asar-'))
  try {
    const catalog = path.join(root,'catalog.db')
    const db = initDatabaseAtPath(catalog)
    db.exec("INSERT INTO tags(id,name) VALUES(1,'Packaged label')")
    const stage = path.join(root,'stage')
    fs.mkdirSync(stage)
    const copied = new Set<string>()
    function copyModule(relative: string): void {
      if (copied.has(relative)) return
      copied.add(relative)
      const source = path.resolve('out/main',relative)
      const text = fs.readFileSync(source,'utf8')
      const target = path.join(stage,'out/main',relative)
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text)
      for (const match of text.matchAll(/require\("(\.[^"]+)"\)/g)) copyModule(path.normalize(path.join(path.dirname(relative),match[1])))
    }
    copyModule('catalogReadWorker.js')
    fs.cpSync(path.resolve('node_modules/better-sqlite3'),path.join(stage,'node_modules/better-sqlite3'),{recursive:true})
    fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'javdex-reader-asar-probe',version:'1.0.0'}))
    const archive = path.join(root,'app.asar')
    await createPackageWithOptions(stage,archive,{unpack:'**/*.node'})
    const harness = path.join(root,'harness')
    fs.mkdirSync(harness)
    fs.writeFileSync(path.join(harness,'package.json'),JSON.stringify({name:'javdex-reader-harness',version:'1.0.0',main:'main.cjs'}))
    const resultPath = path.join(root,'result.json')
    fs.writeFileSync(path.join(harness,'main.cjs'),`
      const {app}=require('electron');const {Worker}=require('node:worker_threads');const fs=require('node:fs');
      app.setPath('userData',${JSON.stringify(path.join(root,'userData'))});
      const timer=setTimeout(()=>app.exit(2),15000);
      app.whenReady().then(()=>{
        app.dock?.hide();
        const worker=new Worker(${JSON.stringify(path.join(archive,'out/main/catalogReadWorker.js'))},{workerData:{databasePath:${JSON.stringify(catalog)}},execArgv:[]});
        let result;
        worker.on('message',message=>{
          if(message.type==='ready')worker.postMessage({type:'read',id:1,query:{}});
          if(message.type==='result'){result=message.result;worker.postMessage({type:'close'});}
          if(message.type==='error'){console.error(message.message);app.exit(1);}
        });
        worker.on('error',error=>{console.error(error);app.exit(1);});
        worker.on('exit',code=>{clearTimeout(timer);if(code!==0||!result){app.exit(1);return;}
          fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({result,versions:process.versions}));app.exit(0);});
      }).catch(error=>{console.error(error);app.exit(1);});
    `)
    const childEnv = {...process.env}
    delete childEnv.ELECTRON_RUN_AS_NODE
    const executable = typeof electron === 'string' ? electron : process.execPath
    await new Promise<void>((resolve,reject) => {
      const child = spawn(executable,[harness],{env:childEnv,stdio:['ignore','pipe','pipe']})
      let output = ''
      child.stdout.on('data',chunk=>{output+=String(chunk)})
      child.stderr.on('data',chunk=>{output+=String(chunk)})
      const timer = setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Electron ASAR fixture timed out'))},25000)
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`Electron ASAR fixture exited ${code}: ${output}`))})
    })
    const result = JSON.parse(fs.readFileSync(resultPath,'utf8'))
    assert.deepEqual(result.result,{items:[{id:1,label:'Packaged label',video_count:0}],hasMore:false})
    const report = {...result, copiedModules:[...copied], nativeUnpack:'**/*.node',
      caveats:['Windowless real Electron, built worker/chunks and native SQLite in synthetic ASAR.',
        'Not a signed installer, all-platform release, full application startup or user catalog.']}
    if(process.env.JAVDEX_ASAR_PROBE_OUTPUT)fs.writeFileSync(path.resolve(process.env.JAVDEX_ASAR_PROBE_OUTPUT),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify(report))
  } finally {closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
