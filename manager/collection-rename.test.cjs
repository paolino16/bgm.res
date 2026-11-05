const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {renameCollection}=require('../js/collection-rename.cjs'),core=require('../js/rename-binding-core.cjs');
async function fixture(t,linked=false){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-collection-rename-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const n of ['record','task','rename_plans','media','mirror'])await fs.mkdir(path.join(dir,n));
 const name='Show EP01 [Group].mkv',file=path.join(dir,'media',name),real=linked?path.join(dir,'mirror',name):file;
 await fs.writeFile(real,'video contents');if(linked)await fs.symlink(real,file,'file');
 const subtitle=file.replace(/\.mkv$/,'.chs.ass'),realSub=real.replace(/\.mkv$/,'.chs.ass');await fs.writeFile(realSub,'subtitle');if(linked)await fs.symlink(realSub,subtitle,'file');
 const source=path.join(dir,'original.mkv');const row={source,subject_id:'42',episode_id:101,episode:1,episode_type:0,category:'episode'};
 const record={entries:{[source]:{target:file,...(linked?{mirror:real}:{})}},episode_bindings:[row]};
 const task={subject_id:'42',episode_bindings:[row],file_decisions:[row]};
 await fs.writeFile(path.join(dir,'record','one.json'),JSON.stringify(record));await fs.writeFile(path.join(dir,'task','one.json'),JSON.stringify(task));
 let work=core.mergeWork({id:'42',title:'Show',files:[{path:file,taskId:'one',source,type:0,episodeId:'101',availability:'available'}]}, {},'WorkSaveNo1');work.EPDetails.EP1.Condition='Watched';
 return {dir,file,real,subtitle,work,target:path.join(dir,'media','Show [Group].mkv'),record};
}
test('library rename moves video and subtitle, updates canonical records and survives reimport',async t=>{
 const f=await fixture(t);let saved;
 const next=await renameCollection({work:f.work,file:f.file,episodeIds:['101','102'],dataDir:f.dir,persist:async n=>saved=n});
 assert.equal(await fs.readFile(f.target,'utf8'),'video contents');assert.equal(await fs.readFile(f.target.replace(/\.mkv$/,'.chs.ass'),'utf8'),'subtitle');await assert.rejects(fs.access(f.file));
 assert.equal(saved,next);assert.equal(next.EPDetails.EP1.Condition,'Watched');assert.equal(next.EPDetails.EP1.AbsolutePath,f.target);
 const record=JSON.parse(await fs.readFile(path.join(f.dir,'record','one.json'),'utf8'));assert.equal(Object.values(record.entries)[0].target,f.target);assert.equal(record.episode_bindings[0].category,'collection');assert.deepEqual(record.episode_bindings[0].episode_ids,[101,102]);
 const imported=await core.readRename(f.dir),refreshed=core.mergeWork(imported.groups[0],next,'WorkSaveNo1');assert.ok(refreshed.EPDetails.EP1.Collection);assert.equal(refreshed.EPDetails.EP1.AbsolutePath,f.target);
});
test('rename never overwrites a collision or changes records when blocked',async t=>{
 const f=await fixture(t);await fs.writeFile(f.target,'other video');
 await assert.rejects(renameCollection({work:f.work,file:f.file,episodeIds:[101,102],dataDir:f.dir,persist:()=>assert.fail()}),/已存在/);
 assert.equal(await fs.readFile(f.target,'utf8'),'other video');assert.equal(await fs.readFile(f.file,'utf8'),'video contents');assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dir,'record','one.json'),'utf8')),f.record);
});
test('failed library persistence rolls back files, subtitles and canonical records',async t=>{
 const f=await fixture(t);
 await assert.rejects(renameCollection({work:f.work,file:f.file,episodeIds:[101,102],dataDir:f.dir,persist:async()=>{throw Error('write failure');}}),/write failure/);
 assert.equal(await fs.readFile(f.file,'utf8'),'video contents');assert.equal(await fs.readFile(f.subtitle,'utf8'),'subtitle');await assert.rejects(fs.access(f.target));assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dir,'record','one.json'),'utf8')),f.record);
});
test('linked media renames the mirror and recreates video and subtitle links to the new paths',async t=>{
 const f=await fixture(t,true);
 const next=await renameCollection({work:f.work,file:f.file,episodeIds:[101,102],dataDir:f.dir,persist:async()=>{}});
 assert.ok((await fs.lstat(f.target)).isSymbolicLink());assert.equal(await fs.readFile(f.target,'utf8'),'video contents');assert.equal(await fs.readlink(f.target),path.join(f.dir,'mirror','Show [Group].mkv'));assert.equal(await fs.readFile(f.target.replace(/\.mkv$/,'.chs.ass'),'utf8'),'subtitle');await assert.rejects(fs.access(f.real));assert.ok(next.EPDetails.EP1.Collection);
});

test('task release group is retained when an old movie filename has no group suffix',async t=>{
 const f=await fixture(t,true),plain=f.file.replace(' EP01 [Group]',''),plainReal=f.real.replace(' EP01 [Group]',''),plainSub=plain.replace(/\.mkv$/,'.chs.ass');
 await fs.rename(f.real,plainReal);await fs.unlink(f.file);await fs.symlink(plainReal,plain,'file');
 await fs.rename(f.real.replace(/\.mkv$/,'.chs.ass'),plainReal.replace(/\.mkv$/,'.chs.ass'));await fs.unlink(f.subtitle);await fs.symlink(plainReal.replace(/\.mkv$/,'.chs.ass'),plainSub,'file');
 const mapping=new Map([[f.file,plain],[f.real,plainReal]]),replace=require('../js/collection-rename.cjs').replacePaths;
 const work=replace(f.work,mapping),record=replace(f.record,mapping);await fs.writeFile(path.join(f.dir,'record','one.json'),JSON.stringify(record));
 const taskPath=path.join(f.dir,'task','one.json'),task=JSON.parse(await fs.readFile(taskPath,'utf8'));task.subtitle_group='AI-Raws';await fs.writeFile(taskPath,JSON.stringify(task));
 const next=await renameCollection({work,file:plain,episodeIds:[101,102],dataDir:f.dir,persist:async()=>{}});
 const target=path.join(f.dir,'media','Show [AI-Raws].mkv');assert.equal(next.EPDetails.EP1.AbsolutePath,target);assert.equal(await fs.readFile(target,'utf8'),'video contents');assert.equal(await fs.readFile(target.replace(/\.mkv$/,'.chs.ass'),'utf8'),'subtitle');
 const refreshed=core.mergeWork((await core.readRename(f.dir)).groups[0],next,'WorkSaveNo1');assert.equal(refreshed.EPDetails.EP1.AbsolutePath,target);assert.equal(refreshed.EPDetails.EP1.SubtitleGroup,'AI-Raws');
});
