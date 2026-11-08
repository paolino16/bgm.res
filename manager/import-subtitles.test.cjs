const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module');

for(const fail of [false,true])test('import automatically checks only affected subtitles; save failure='+fail,async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-import-subs-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  for(const folder of ['task','record'])await fs.mkdir(path.join(directory,'rename',folder),{recursive:true});
  const videos=[];
  for(const [task,id]of [['one','42'],['two','43']]){
    const video=path.join(directory,task+'.mkv');videos.push(video);await fs.writeFile(video,'video');
    await fs.writeFile(path.join(directory,'rename','task',task+'.json'),JSON.stringify({uuid:task,subject_id:id,name:'Show '+id}));
    await fs.writeFile(path.join(directory,'rename','record',task+'.json'),JSON.stringify({entries:{source:{target:video}},episode_bindings:[{source:'source',subject_id:id,episode_id:123,episode_type:0,episode:1}]}));
  }
  await fs.writeFile(path.join(directory,'one.ass'),'subtitle');
  const handlers=new Map(),probed=[],events=[];let scans=0;
  const filename=path.resolve('js/rename-binding-main.cjs'),nativeRequire=createRequire(filename),module={exports:{}};
  class DB{loadDatabase(cb){cb();}find(q,cb){cb(null,[]);}update(q,v,o,cb){cb(null);}}
  vm.runInNewContext(await fs.readFile(filename,'utf8'),{module,exports:module.exports,__dirname:path.dirname(filename),process:{env:{BGM_RES_DATA_DIR:directory}},require:name=>{
    if(name==='./cadensview-main.cjs')return {register(){}};
  if(name==='electron')return {net:{},BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send:event=>events.push(event)}}]}};
    if(name==='./rename-integration.cjs')return {create:({onReturn})=>({onReturn,request:async()=>({state:'completed',action:'execute',task_id:'one'})})};
    if(name==='./metadata-hydration.cjs')return {create:()=>({hydrate:async()=>{}})};
    if(name==='./subtitle-index.cjs'){
      const real=nativeRequire(name);
      return {...real,SubtitleIndex:class extends real.SubtitleIndex{
        constructor(options){super({...options,resolveTool:async()=>({}),probeFile:async file=>{probed.push(file);return {internal:[{codec:'ass'}]};}});}
        async scanFiles(...args){scans++;await super.scanFiles(...args);if(fail)throw Error('test save failure');}
      }};
    }
    return nativeRequire(name);
  }});
  await module.exports.start({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}},app:{getPath:()=>directory},sysdata:{set(){}},Datastore:DB});
  assert.equal(scans,0);
  const context=handlers.get('subtitles:context')(null,'WorkSaveNo1');assert.equal(context.chapters[0].number,1);assert.deepEqual(context.chapters[0].videos,[videos[0]]);
  const job=await handlers.get('organizer:job')(null,'a'.repeat(32));
  assert.deepEqual(probed,[videos[0]]);assert.equal(scans,1);
  const data=handlers.get('library:read')();
  assert.equal(data.WorkSaveNo1.SubtitleSummary.status,'complete');assert.equal(data.WorkSaveNo2.SubtitleSummary.status,'unknown');
  const details=handlers.get('subtitles:details')(null,'WorkSaveNo1');assert.equal(details.files[0].external.length,1);assert.equal(details.files[0].internal.length,1);
  assert.ok(events.includes('library:updated'));
  const repeated=await handlers.get('organizer:job')(null,'a'.repeat(32));assert.equal(scans,1);
  if(fail){assert.match(job.result.warning,/作品已导入/);assert.equal(repeated.result.warning,job.result.warning);}
});
