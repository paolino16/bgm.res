const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {dismiss}=require('../js/file-operations.cjs');
const {inspect}=require('../js/file-health.cjs');
const core=require('../js/rename-binding-core.cjs');
test('clearing an anomaly retains its file and remains cleared until the file is repaired',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-dismiss-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const file=path.join(folder,'empty.mkv');await fs.writeFile(file,'');
  const group={id:'42',title:'Show',files:[{path:file,type:'extra'}]};
  let work=core.mergeWork(await inspect(group),{},'WorkSaveNo1');
  work=dismiss(work,[file]);assert.equal((await fs.stat(file)).size,0);assert.equal(work.RenameBinding.invalidResources.length,0);
  work=core.mergeWork(await inspect(group,work),work,'WorkSaveNo1');assert.equal(work.RenameBinding.invalidResources.length,0);
  await fs.writeFile(file,'repaired');work=core.mergeWork(await inspect(group,work),work,'WorkSaveNo1');assert.equal(work.RenameBinding.resources.length,1);assert.equal(work.RenameBinding.dismissedResources.length,0);
});
test('trash requires confirmation, rejects unrelated paths, preserves surviving versions, and survives reimport',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-trash-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const first=path.join(directory,'A.mkv'),second=path.join(directory,'B.mkv'),outside=path.join(directory,'unregistered.mkv');
  for(const file of [first,second,outside])await fs.writeFile(file,'video');
  const group={id:'42',title:'Show',files:[first,second].map(file=>({path:file,type:0,episodeId:'123',number:'1',availability:'available'}))};
  const work=core.mergeWork(group,{},'WorkSaveNo1');work.EPDetails.EP1.Condition='Watched';
  const handlers=new Map();let response=0,trashCalls=0,dialogs=0,fail=false;
  const electron={net:{},BrowserWindow:{fromWebContents:()=>null},dialog:{async showMessageBox(options){dialogs++;assert.match(options.detail,/A\.mkv/);return {response};}},shell:{async trashItem(file){trashCalls++;if(fail)throw Error('file locked');await fs.unlink(file);}}};
  class DB{loadDatabase(cb){cb();}find(query,cb){cb(null,[{_id:'WorkSaveNo1',data:work}]);}update(query,changes,options,cb){setImmediate(()=>cb(null));}}
  const filename=path.resolve('js/rename-binding-main.cjs'),nativeRequire=createRequire(filename),module={exports:{}};
  vm.runInNewContext(await fs.readFile(filename,'utf8'),{module,exports:module.exports,require:name=>name==='electron'?electron:nativeRequire(name),process:{env:{BGM_RES_DATA_DIR:directory}},__dirname:path.dirname(filename)});
  await module.exports.start({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}},app:{getPath:()=>directory},sysdata:{set(){}},Datastore:DB});
  const trash=target=>handlers.get('library:trash-file')({sender:{}},{id:'WorkSaveNo1',path:target});
  await assert.rejects(trash(outside),/已登记/);assert.equal(dialogs,0);assert.equal(trashCalls,0);
  assert.equal((await trash(first)).cancelled,true);assert.equal(trashCalls,0);await fs.access(first);
  response=1;fail=true;await assert.rejects(trash(first),/locked/);await fs.access(first);assert.equal(handlers.get('library:read')().WorkSaveNo1.EPDetails.EP1.Versions.length,2);
  fail=false;const result=await trash(first);let updated=result.data.WorkSaveNo1;
  await assert.rejects(fs.access(first));await fs.access(second);await fs.access(outside);
  assert.equal(updated.EPTrueNum,1);assert.equal(updated.EPDetails.EP1.AbsolutePath,second);assert.equal(updated.EPDetails.EP1.Condition,'Watched');assert.equal(updated.EPDetails.EP1.Versions.length,1);
  updated=core.mergeWork(await inspect(group,updated),updated,'WorkSaveNo1');assert.equal(updated.EPTrueNum,1);assert.equal(updated.RenameBinding.invalidResources.length,0);
});
test('deleting a chapter removes stale recent pointers instead of pointing at the next episode',()=>{
  const one={path:path.resolve('one.mkv'),type:0,episodeId:'1',number:'1'},two={path:path.resolve('two.mkv'),type:0,episodeId:'2',number:'2'};
  const previous=core.mergeWork({id:'42',title:'Show',files:[one,two]}, {},'WorkSaveNo1');
  const next=core.mergeWork({id:'42',title:'Show',files:[{...one,availability:'removed'},two]},previous,'WorkSaveNo1');
  const recent=core.remapRecent([{workID:'WorkSaveNo1',episode:'EP1'},{workID:'WorkSaveNo1',episode:'EP2'}],previous,next);
  assert.deepEqual(recent,[{workID:'WorkSaveNo1',episode:'EP1'}]);assert.equal(next.EPDetails.EP1.EpisodeID,'2');
});
test('single and bulk record cleanup never delete files and reject clearing healthy entries',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-clear-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const first=path.join(directory,'empty-a.mkv'),second=path.join(directory,'empty-b.mkv'),video=path.join(directory,'video.mkv');
  for(const file of [first,second])await fs.writeFile(file,'');await fs.writeFile(video,'video');
  const group={id:'42',title:'Show',files:[{path:first,type:'extra',availability:'empty'},{path:second,type:'extra',availability:'empty'},{path:video,type:0,episodeId:'123',number:'1',availability:'available'}]};
  const work=core.mergeWork(group,{},'WorkSaveNo1'),handlers=new Map();let fail=false;
  class DB{loadDatabase(cb){cb();}find(query,cb){cb(null,[{_id:'WorkSaveNo1',data:work}]);}update(query,changes,options,cb){setImmediate(()=>cb(fail?Error('write failure'):null));}}
  const filename=path.resolve('js/rename-binding-main.cjs'),nativeRequire=createRequire(filename),module={exports:{}};
  vm.runInNewContext(await fs.readFile(filename,'utf8'),{module,exports:module.exports,require:name=>name==='electron'?{net:{}}:nativeRequire(name),process:{env:{BGM_RES_DATA_DIR:directory}},__dirname:path.dirname(filename)});
  await module.exports.start({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}},app:{getPath:()=>directory},sysdata:{set(){}},Datastore:DB});
  const clear=selection=>handlers.get('library:clear-records')(null,selection);
  await assert.rejects(clear({id:'WorkSaveNo1',paths:[video]}),/已登记/);
  fail=true;await assert.rejects(clear({id:'WorkSaveNo1',paths:[first]}),/write failure/);assert.equal(handlers.get('library:read')().WorkSaveNo1.RenameBinding.invalidResources.length,2);
  fail=false;assert.equal((await clear({id:'WorkSaveNo1',paths:[first]})).cleared,1);
  const result=await clear({all:true});assert.equal(result.cleared,1);assert.equal(result.data.WorkSaveNo1.RenameBinding.invalidResources.length,0);
  assert.equal((await fs.stat(first)).size,0);assert.equal((await fs.stat(second)).size,0);assert.equal((await fs.stat(video)).size,5);
});
