const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const core=require('../js/rename-binding-core.cjs');
test('rename special categories and compound SP numbers stay separate from main episodes',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-binding-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'task'));await fs.mkdir(path.join(dir,'record'));
  const names=['Show EP03.mkv','Specials/Show [SP03_01].mkv','Specials/Show [SP03_02].mkv','Extras/Show CM01.mkv'];
  const bindings=names.map((name,i)=>({source:path.join(dir,'source'+i),subject_id:'42',episode_id:i===0?123:null,category:i===0?'episode':i===3?'extra':'special',...(i===0?{episode_type:0,episode:3}:{})}));
  await fs.writeFile(path.join(dir,'task','test.json'),JSON.stringify({subject_id:'42',name:'Show'}));
  await fs.writeFile(path.join(dir,'record','test.json'),JSON.stringify({episode_bindings:bindings,entries:Object.fromEntries(bindings.map((b,i)=>[b.source,{target:path.join(dir,names[i])}]))}));
  const {groups}=await core.readRename(dir);const work=core.mergeWork(groups[0],{},'WorkSaveNo1');
  assert.equal(work.EPTrueNum,1);assert.equal(work.SPTrueNum,0);assert.equal(work.RenameBinding.resources.length,3);
  assert.deepEqual(work.RenameBinding.resources.filter(s=>s.type===1).map(s=>s.number),['03_01','03_02']);
  assert.ok(work.RenameBinding.resources.every(s=>s.episodeId===null));
  assert.equal(core.projectEpisodes(work,[{id:123,type:0,ep:3}]).length,1);
});
test('reclassification preserves watch state by file and recent viewing is archived with the moved special',()=>{
  const file={path:path.resolve('Show [SP03_01].mkv'),number:'03_01',episodeId:null,type:1};
  const old={WorkSaveNo:'WorkSaveNo1',URL:path.dirname(file.path),EPDetails:{EP8:{AbsolutePath:file.path,URL:path.basename(file.path),Condition:'Watched',EpisodeNumber:'03'}},SPDetails:{}};
  const work=core.mergeWork({title:'Show',id:'42',files:[file]},old,'WorkSaveNo1');
  assert.equal(work.EPTrueNum,0);assert.equal(work.SPTrueNum,0);assert.equal(work.RenameBinding.resources[0].Condition,'Watched');
  assert.deepEqual(core.remapRecent([{workID:'WorkSaveNo1',episode:'EP8',lastWatched:'unchanged'}],old,work),[]);
  assert.equal(work.RenameBinding.resources[0].LastWatched.lastWatched,'unchanged');
  assert.equal(core.mergeWork({title:'Show',id:'42',files:[file]},work,'WorkSaveNo1').RenameBinding.resources[0].Condition,'Watched');
});
test('multiple copies of an explicitly bound episode remain versions of one chapter',()=>{
  const files=['A','B'].map(n=>({path:path.resolve(n+'.mkv'),episodeId:'123',number:'3',type:0}));
  const work=core.mergeWork({title:'Show',id:'42',files},{},'WorkSaveNo1');
  assert.equal(work.EPTrueNum,1);assert.equal(work.EPDetails.EP1.Versions.length,2);
});
test('empty files leave the active list while usable versions and archived watch states survive',()=>{
  const bad={path:path.resolve('empty.mkv'),episodeId:'123',number:'3',type:0,availability:'empty'};
  const good={...bad,path:path.resolve('good.mkv'),availability:'available'};
  const previous={URL:path.dirname(bad.path),EPDetails:{EP1:{EpisodeID:'123',AbsolutePath:bad.path,Condition:'Watched'}},SPDetails:{}};
  const work=core.mergeWork({title:'Show',id:'42',files:[bad,good]},previous,'WorkSaveNo1');
  assert.equal(work.EPTrueNum,1);assert.equal(work.EPDetails.EP1.Versions.length,1);
  assert.equal(work.EPDetails.EP1.AbsolutePath,good.path);assert.equal(work.EPDetails.EP1.Condition,'Watched');
  assert.equal(work.RenameBinding.invalidResources[0].path,bad.path);
  assert.equal(work.RenameBinding.invalidResources[0].Condition,'Watched');
});
