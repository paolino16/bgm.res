const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
test('desktop edits are asynchronous, atomic, and cannot change bound file paths',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-desktop-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const handlers=new Map();let fail=false,writes=0;
  class DB{
    loadDatabase(cb){cb();}
    find(query,cb){cb(null,[{_id:'WorkSaveNo1',data:{WorkSaveNo:'WorkSaveNo1',Name:'Show',URL:'D:/media',EPDetails:{EP1:{Condition:'Unwatched',AbsolutePath:'D:/media/video.mkv'},EP2:{Condition:'Unwatched'}}}}]);}
    update(query,changes,options,cb){writes++;setImmediate(()=>cb(fail?Error('disk failure'):null));}
  }
  const filename=path.resolve('js/rename-binding-main.cjs');
  const source=await fs.readFile(filename,'utf8');
  const nativeRequire=createRequire(filename);const module={exports:{}};
  vm.runInNewContext(source,{module,exports:module.exports,require:name=>name==='electron'?{net:{}}:nativeRequire(name),process:{env:{BGM_RES_DATA_DIR:directory}},__dirname:path.dirname(filename)});
  const result=await module.exports.start({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}},app:{getPath:()=>directory},sysdata:{set(){}},Datastore:DB});
  const read=()=>handlers.get('library:read')();const edit=changes=>handlers.get('library:edit')(null,{id:'WorkSaveNo1',changes});
  const snapshot=read();snapshot.WorkSaveNo1.Name='outside mutation';assert.equal(read().WorkSaveNo1.Name,'Show');
  await edit({'EPDetails.EP1.Condition':'Watched','EPDetails.EP2.Condition':'Watched'});
  assert.equal(writes,1);assert.equal(read().WorkSaveNo1.EPDetails.EP2.Condition,'Watched');
  await assert.rejects(edit({'EPDetails.EP1.AbsolutePath':'D:/other.mkv'}),/不支持/);
  await assert.rejects(edit({'EPDetails.EP99.Condition':'Watched'}),/章节不存在/);
  await edit({'SpecialEpisodeStates.123':'Watched'});assert.equal(read().WorkSaveNo1.SpecialEpisodeStates['123'],'Watched');
  await assert.rejects(edit({'SpecialEpisodeStates.invalid':'Watched'}),/不支持/);
  const saved=await edit({DefaultSubtitleGroup:'SweetSub&LoliHouse'});
  assert.equal(saved.DefaultSubtitleGroup,'SweetSub&LoliHouse');
  assert.equal(read().WorkSaveNo1.DefaultSubtitleGroup,'SweetSub&LoliHouse');
  await assert.rejects(edit({DefaultSubtitleGroup:''}),/默认字幕组无效/);
  await assert.rejects(edit({DefaultSubtitleGroup:123}),/默认字幕组无效/);
  fail=true;await assert.rejects(edit({DefaultSubtitleGroup:'Other'}),/disk failure/);
  assert.equal(read().WorkSaveNo1.DefaultSubtitleGroup,'SweetSub&LoliHouse');
  fail=true;await assert.rejects(edit({Name:'Unsaved'}),/disk failure/);
  assert.equal(result.data.WorkSaveNo1.Name,'Show');assert.equal(result.data.WorkSaveNo1.EPDetails.EP1.AbsolutePath,'D:/media/video.mkv');
});
test('refresh rescans disk and removed empty files stay out of the anomaly list',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-recheck-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const rename=path.join(directory,'rename');await fs.mkdir(path.join(rename,'task'),{recursive:true});await fs.mkdir(path.join(rename,'record'));
  const video=path.join(directory,'Show EP01.mkv'),extra=path.join(directory,'empty.mkv');await fs.writeFile(video,'video');await fs.writeFile(extra,'');
  await fs.writeFile(path.join(rename,'task','one.json'),JSON.stringify({subject_id:'42',name:'Show'}));
  await fs.writeFile(path.join(rename,'record','one.json'),JSON.stringify({entries:{source:{target:video},extra:{target:extra}},episode_bindings:[{source:'source',subject_id:'42',episode_id:123,episode_type:0,episode:1},{source:'extra',category:'extra',subject_id:'42'}]}));
  const handlers=new Map();
  class DB{loadDatabase(cb){cb();}find(query,cb){cb(null,[]);}update(query,changes,options,cb){setImmediate(()=>cb(null));}}
  const filename=path.resolve('js/rename-binding-main.cjs'),nativeRequire=createRequire(filename),module={exports:{}};
  vm.runInNewContext(await fs.readFile(filename,'utf8'),{module,exports:module.exports,require:name=>name==='electron'?{net:{}}:nativeRequire(name),process:{env:{BGM_RES_DATA_DIR:directory,BGM_RENAME_DATA:rename}},__dirname:path.dirname(filename)});
  await module.exports.start({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}},app:{getPath:()=>directory},sysdata:{set(){}},Datastore:DB});
  assert.equal(handlers.get('library:read')().WorkSaveNo1.RenameBinding.invalidResources.length,1);
  await fs.unlink(extra);
  const save=handlers.get('library:edit')(null,{id:'WorkSaveNo1',changes:{'EPDetails.EP1.Condition':'Watched'}});
  const check=handlers.get('library:recheck')();await save;const result=await check;
  assert.equal(result.report.checked,2);assert.equal(result.report.removed,1);assert.equal(result.data.WorkSaveNo1.RenameBinding.invalidResources.length,0);assert.equal(result.data.WorkSaveNo1.EPDetails.EP1.Condition,'Watched');
  const repeated=await handlers.get('library:recheck')();assert.equal(repeated.report.removed,0);assert.equal(repeated.data.WorkSaveNo1.RenameBinding.invalidResources.length,0);
});
