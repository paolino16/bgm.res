const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {loadCatalogue,specialChapters,regularChapters}=require('../js/episode-catalog.cjs');
test('catalogue includes every episode type and all pages',async()=>{const offsets=[];const rows=await loadCatalogue(async offset=>{offsets.push(offset);return offset===0?{total:3,data:[{id:1,type:0},{id:2,type:1}]}:{total:3,data:[{id:3,type:2}]};});assert.deepEqual(offsets,[0,2]);assert.equal(rows.length,3);});
test('failed or truncated later pages never turn into a partial missing-file catalogue',async()=>{await assert.rejects(loadCatalogue(async offset=>offset?{total:2,data:[]}:{total:2,data:[{id:1,type:0}]}),/完整/);await assert.rejects(loadCatalogue(async offset=>offset?{total:2,data:[{id:1,type:1}]}:{total:2,data:[{id:1,type:0}]}),/重复/);});
test('special cards use explicit IDs, retain unmapped chapters, and group OP/ED separately',()=>{const file=path.resolve('SP01.mkv'),alt=path.resolve('SP01-v2.mkv');const work={bgmID:'42',EPDetails:{EP1:{EpisodeID:'100',Versions:[{path:path.resolve('EP01.mkv')}]}},RenameBinding:{resources:[{path:file,episodeId:'200',type:1},{path:alt,episodeId:'200',type:1},{path:path.resolve('SP02.mkv'),episodeId:null,type:1}],files:[{path:file,episodeId:'200',availability:'available'}]}};
 const groups=specialChapters(work,[{id:100,type:0,sort:1},{id:200,type:1,sort:1,name:'OVA'},{id:201,type:1,sort:2,name:'SP2'},{id:300,type:2,sort:1},{id:400,type:3,sort:1}]);assert.deepEqual(groups.map(g=>g.type),[1,2,3]);assert.equal(groups[0].rows[0].state,'mapped');assert.equal(groups[0].rows[0].files.length,2);assert.equal(groups[0].rows[1].state,'unmapped');assert.equal(groups[1].rows[0].state,'unmapped');});
test('legacy SP bindings and unavailable mapped files remain distinct from unbound files',()=>{const file=path.resolve('legacy-sp.mkv');const groups=specialChapters({URL:path.dirname(file),SPDetails:{SP1:{EpisodeID:'20',URL:path.basename(file)}},RenameBinding:{invalidResources:[{episodeId:'20',path:file,availability:'missing'}]}},[{id:20,type:1,sort:12.5},{id:21,type:1,sort:2}]);assert.equal(groups[0].rows[0].id,21);assert.equal(groups[0].rows[0].state,'unmapped');assert.equal(groups[0].rows[1].state,'unavailable');});

test('regular catalogue exposes missing episodes and distinguishes unavailable and upcoming files',()=>{
 const file=path.resolve('ep1.mkv'),missing=path.resolve('ep3.mkv');
 const work={bgmID:'42',EPDetails:{EP1:{EpisodeID:'101',Versions:[{path:file},{path:path.resolve('ep1-alt.mkv')}]}},RenameBinding:{files:[{episodeId:'101',path:file,availability:'available'},{episodeId:'103',path:missing,availability:'missing'}]}};
 const catalog=[{id:101,type:0,sort:1},{id:102,type:0,sort:2},{id:103,type:0,sort:3},{id:104,type:0,sort:4,airdate:'2099-01-01'},{id:200,type:1,sort:1}];
 const report=regularChapters(work,catalog,'2026-11-02');
 assert.deepEqual(report.rows.map(r=>r.state),['mapped','unmapped','unavailable','upcoming']);
 assert.equal(report.rows[0].files.length,2);assert.deepEqual(report.missing.map(r=>r.id),[102]);assert.deepEqual(report.unavailable.map(r=>r.id),[103]);assert.equal(report.unmatchedSlots.length,0);
});

test('regular mapping never uses local sequence index across an episode gap',()=>{
 const work={EPDetails:{EP1:{LocalIndex:1,EpisodeNumber:'1',Versions:[{path:path.resolve('one.mkv')}]},EP2:{LocalIndex:2,EpisodeNumber:'3',Versions:[{path:path.resolve('three.mkv')}]},EP3:{LocalIndex:3,Versions:[{path:path.resolve('unknown.mkv')}]}}};
 const report=regularChapters(work,[1,2,3].map(n=>({id:100+n,type:0,sort:n})),'2026-11-02');
 assert.deepEqual(report.rows.map(r=>r.state),['mapped','unmapped','mapped']);assert.deepEqual(report.rows[2].slotKeys,['EP2']);assert.equal(report.unmatchedSlots[0][0],'EP3');
});

test('regular mapping respects explicit IDs and rejects ambiguous number fallback',()=>{
 const work={EPDetails:{EP1:{EpisodeID:999,EpisodeNumber:1,AbsolutePath:path.resolve('wrong.mkv')},EP2:{EpisodeNumber:2,AbsolutePath:path.resolve('two.mkv')},EP3:{EpisodeNumber:2,AbsolutePath:path.resolve('other.mkv')}},RenameBinding:{files:[{subjectId:'other',episodeId:101,path:path.resolve('foreign.mkv')}]}};
 const report=regularChapters(work,[{id:101,type:0,sort:1},{id:102,type:0,sort:2}]);assert.equal(report.missing.length,2);assert.equal(report.unmatchedSlots.length,3);
});

test('an unavailable version does not hide a usable alternative or count a chapter twice',()=>{
 const work={RenameBinding:{files:[{episodeId:101,path:path.resolve('bad.mkv'),availability:'missing'},{episodeId:101,path:path.resolve('good.mkv'),availability:'available'}]}};
 const report=regularChapters(work,[{id:101,type:0,sort:1}]);assert.equal(report.rows[0].state,'mapped');assert.equal(report.rows[0].usable.length,1);assert.equal(report.missing.length,0);
});
