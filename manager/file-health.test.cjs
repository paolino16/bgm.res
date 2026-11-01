const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {inspect}=require('../js/file-health.cjs');
const {mergeWork}=require('../js/rename-binding-core.cjs');
test('refresh removes deleted empty anomalies and keeps them dismissed after reimport',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-health-'));t.after(()=>fs.rm(folder,{force:true,recursive:true}));
  const video=path.join(folder,'video.mkv'),extra=path.join(folder,'empty.mkv');await fs.writeFile(video,'video bytes');await fs.writeFile(extra,'');
  const group={id:'42',title:'Show',files:[{path:video,type:0,episodeId:'1',number:'1'},{path:extra,type:'extra'}]};
  let work=mergeWork(await inspect(group),{},'WorkSaveNo1');assert.equal(work.RenameBinding.invalidResources.length,1);work.EPDetails.EP1.Condition='Watched';
  await fs.unlink(extra);work=mergeWork(await inspect(group,work),work,'WorkSaveNo1');assert.equal(work.RenameBinding.invalidResources.length,0);assert.deepEqual(work.RenameBinding.ignoredMissing,[extra]);
  work=mergeWork(await inspect(group,work),work,'WorkSaveNo1');assert.equal(work.RenameBinding.invalidResources.length,0);assert.equal(work.EPDetails.EP1.Condition,'Watched');
  await fs.writeFile(extra,'restored');work=mergeWork(await inspect(group,work),work,'WorkSaveNo1');assert.equal(work.RenameBinding.resources.length,1);assert.equal(work.RenameBinding.ignoredMissing.length,0);
});
test('new missing regular episodes remain visible as anomalies',async()=>{
  const group={id:'42',title:'Show',files:[{path:path.resolve('missing.mkv'),type:0,episodeId:'1',number:'1'}]};
  const stat=async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};
  let work=mergeWork(await inspect(group,undefined,stat),{},'WorkSaveNo1');assert.equal(work.RenameBinding.invalidResources[0].availability,'missing');
  work=mergeWork(await inspect(group,work,stat),work,'WorkSaveNo1');assert.equal(work.RenameBinding.invalidResources.length,1);
});
test('deleted known extras leave the list even if they were previously playable',async()=>{
  const file={path:path.resolve('deleted-extra.mkv'),type:'extra'};
  const previous={RenameBinding:{resources:[file]}};
  const stat=async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};
  const checked=await inspect({id:'42',title:'Show',files:[file]},previous,stat);
  const work=mergeWork(checked,previous,'WorkSaveNo1');assert.equal(work.RenameBinding.invalidResources.length,0);assert.deepEqual(work.RenameBinding.ignoredMissing,[file.path]);
});
