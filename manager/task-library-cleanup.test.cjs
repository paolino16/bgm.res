const {test}=require('node:test');const assert=require('node:assert/strict');
const {removedWorks}=require('../js/task-library-cleanup.cjs');
test('deletion matches legacy task filenames without removing a split child',()=>{
 const data={WorkSaveNo1:{RenameBinding:{files:[{taskId:'one.json'}]}},WorkSaveNo2:{RenameBinding:{files:[{taskId:'child',parentTaskIds:['one']}]}}};
 assert.deepEqual(removedWorks(data,'one'),['WorkSaveNo1']);
 assert.deepEqual(removedWorks(data,'one.json'),['WorkSaveNo1']);
});
test('task deletion removes only sole-task imported works and preserves shared or legacy works',()=>{
 const data={WorkSaveNo1:{RenameBinding:{files:[{taskId:'one'},{taskId:'one'}]}},WorkSaveNo2:{RenameBinding:{files:[{taskId:'one'},{taskId:'two'}]}},WorkSaveNo3:{EPDetails:{}},WorkSaveNo4:{RenameBinding:{files:[]}},WorkSaveNo5:{RenameBinding:{files:[{taskId:'two'}]}}};
 assert.deepEqual(removedWorks(data,'one'),['WorkSaveNo1']);
});

test('single-task completion rescans affected subjects and leaves the rest of the library alone',()=>{
 const {needsTaskRefresh}=require('../js/task-library-cleanup.cjs');
 assert.equal(needsTaskRefresh({files:[{taskId:'one'}]},null,'one'),true);
 assert.equal(needsTaskRefresh({files:[{taskId:'two'}]},{RenameBinding:{files:[{taskId:'one'},{taskId:'two'}]}},'one'),true);
 assert.equal(needsTaskRefresh({files:[{taskId:'two'}]},{RenameBinding:{files:[{taskId:'two'}]}},'one'),false);
 assert.equal(needsTaskRefresh({files:[{taskId:'one.json'}]},null,'one'),true);
 assert.equal(needsTaskRefresh({files:[{taskId:'two'}]},null),true);
});

test('completed deletion rebuilds a shared work without checking unrelated media',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{createRequire}=require('node:module');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-delete-refresh-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 for(const folder of ['task','record'])await fs.mkdir(path.join(directory,'rename',folder),{recursive:true});
 const core=require('../js/rename-binding-core.cjs'),groups=new Map();
 for(const [task,sid]of [['one','42'],['two','42'],['three','43']]){
  const target=path.join(directory,task+'.mkv');await fs.writeFile(target,'video');
  await fs.writeFile(path.join(directory,'rename','task',task+'.json'),JSON.stringify({uuid:task,subject_id:sid,name:'Show '+sid}));
  await fs.writeFile(path.join(directory,'rename','record',task+'.json'),JSON.stringify({entries:{[task]:{target}},episode_bindings:[{source:task,subject_id:sid,episode_id:task==='one'?101:102,episode_type:0,episode:1}]}));
 }
 const parsed=await core.readRename(path.join(directory,'rename'));parsed.groups.forEach((g,i)=>groups.set('WorkSaveNo'+(i+1),core.mergeWork(g,{},'WorkSaveNo'+(i+1))));
 class DB{loadDatabase(cb){cb();}find(q,cb){cb(null,[...groups].map(([key,data])=>({_id:key,data})));}update(q,v,o,cb){cb(null);}remove(q,o,cb){cb(null);}}
 const handlers=new Map(),checked=[];const filename=path.resolve('js/rename-binding-main.cjs'),nativeRequire=createRequire(filename),module={exports:{}};
 vm.runInNewContext(await fs.readFile(filename,'utf8'),{module,exports:module.exports,__dirname:path.dirname(filename),process:{env:{BGM_RES_DATA_DIR:directory}},require:name=>{
  if(name==='electron')return {net:{},BrowserWindow:{getAllWindows:()=>[]}};
  if(name==='./file-health.cjs')return {inspect:async(group,previous)=>{checked.push(group.id);return nativeRequire(name).inspect(group,previous);}};
  if(name==='./rename-integration.cjs')return {create:({onReturn})=>({onReturn,request:async()=>({state:'completed',action:'delete-task',task_id:'one'})})};
  return nativeRequire(name);
 }});
 await module.exports.start({ipcMain:{handle:(k,v)=>handlers.set(k,v),on(){}},app:{getPath:()=>directory},sysdata:{set(){}},Datastore:DB});checked.length=0;
 await fs.unlink(path.join(directory,'rename','task','one.json'));await fs.unlink(path.join(directory,'rename','record','one.json'));
 await handlers.get('organizer:job')(null,'a'.repeat(32));assert.deepEqual(checked,['42']);
 const works=handlers.get('library:read')();assert.equal(works.WorkSaveNo1.RenameBinding.files.length,1);assert.equal(works.WorkSaveNo2.RenameBinding.files.length,1);
});

test('split subject tasks are refreshed when their parent pack completes',()=>{
 const {needsTaskRefresh}=require('../js/task-library-cleanup.cjs');
 assert.equal(needsTaskRefresh({files:[{taskId:'oad-child',parentTaskIds:['tv-pack']}]},null,'tv-pack'),true);
 assert.equal(needsTaskRefresh({files:[{taskId:'oad-child',parentTaskIds:['tv-pack']}]},null,'unrelated'),false);
});
