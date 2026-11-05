const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const crypto=require('node:crypto');
const core=require('../js/rename-binding-core.cjs');const {regularChapters}=require('../js/episode-catalog.cjs');const {filesOf,summary}=require('../js/subtitle-index.cjs');const {watchedThrough}=require('../js/desktop-actions.cjs');
const file=path.resolve('Show [Group].mkv');
test('combined file covers both chapters, counts as main content and keeps watch state across refresh',()=>{
 const group={id:'42',title:'Show',files:[{path:file,collection:true,episodeIds:['101','102'],type:0,availability:'available'}]};
 let work=core.mergeWork(group,{},'WorkSaveNo1');assert.ok(work.EPDetails.EP1.Collection);assert.equal(work.RenameBinding.resources.length,0);
 const report=regularChapters(work,[{id:101,type:0,sort:1},{id:102,type:0,sort:2}]);assert.equal(report.missing.length,0);assert.equal(report.unmatchedSlots.length,0);assert.equal(report.rows[1].usable[0].path,file);
 assert.deepEqual(filesOf(work),[file]);assert.deepEqual(watchedThrough(work,'EP1'),{'EPDetails.EP1.Condition':'Watched'});
 work.EPDetails.EP1.Condition='Watched';work=core.mergeWork(group,work,'WorkSaveNo1');assert.equal(work.EPDetails.EP1.Condition,'Watched');
});
test('manual classification survives source reimport and does not promote unrelated extras',()=>{
 const key=crypto.createHash('sha256').update(core.normalized(file)).digest('hex');
 const work=core.mergeWork({id:'42',title:'Show',files:[{path:file,episodeId:'101',type:1},{path:path.resolve('OP.mkv'),type:2}]},{CollectionBindings:{[key]:{episodeIds:['101','102']}}},'WorkSaveNo1');
 assert.ok(work.EPDetails.EP1.Collection);assert.equal(work.EPDetails.EP1.EpisodeID,null);assert.deepEqual(work.EPDetails.EP1.EpisodeIDs,['101','102']);assert.equal(work.RenameBinding.resources.length,1);
 const report=regularChapters(work,[{id:101,type:0,sort:1},{id:102,type:0,sort:2},{id:103,type:0,sort:3}]);assert.deepEqual(report.missing.map(e=>e.id),[103]);
});
test('unavailable collections never satisfy missing chapter checks with an active slot',()=>{
 const work=core.mergeWork({id:'42',title:'Show',files:[{path:file,collection:true,episodeIds:['101','102'],type:0,availability:'missing'}]}, {},'WorkSaveNo1');
 assert.equal(work.EPTrueNum,0);assert.equal(work.RenameBinding.invalidResources.length,1);assert.equal(regularChapters(work,[{id:101,type:0,sort:1},{id:102,type:0,sort:2}]).unavailable.length,2);
});
