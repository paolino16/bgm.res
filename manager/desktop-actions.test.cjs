const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {mediaType,watchedThrough,episodePath,episodeLink}=require('../js/desktop-actions.cjs');
test('default subtitle group applies across episodes, survives merging, and falls back when unavailable',()=>{
 const {subtitleGroup,preferredVersion}=require('../js/desktop-actions.cjs');
 const {mergeWork}=require('../js/rename-binding-core.cjs');
 const files=[1,2].flatMap(number=>['Other','SweetSub&LoliHouse'].map(group=>({path:path.resolve(`media/Show EP0${number} [${group}].mkv`),subtitleGroup:group,episodeId:String(number),number:String(number),type:0,availability:'available'})));
 const work=mergeWork({id:'1',title:'Show',files},{DefaultSubtitleGroup:'SweetSub&LoliHouse'},'WorkSaveNo1');
 for(const slot of Object.values(work.EPDetails))assert.match(episodePath(work,slot),/SweetSub&LoliHouse/);
 assert.equal(subtitleGroup(work,files[1].path),'SweetSub&LoliHouse');
 assert.equal(subtitleGroup({},path.resolve('Show [SweetSub&LoliHouse].mkv')),'SweetSub&LoliHouse');
 assert.equal(subtitleGroup({},path.resolve('Show.mkv')),'');
 assert.equal(preferredVersion(work,[files[0]]),null);
 files[1].availability='missing';
 assert.equal(episodePath(work,work.EPDetails.EP1),files[0].path);
 assert.equal(mergeWork({id:'1',title:'Show',files},JSON.parse(JSON.stringify(work)),'WorkSaveNo1').DefaultSubtitleGroup,'SweetSub&LoliHouse');
});
test('media filters normalize TV, theatrical, OVA, OAD and WEB names',()=>{
  assert.equal(mediaType({Type:'tv'}),'TV');assert.equal(mediaType({Type:'Movie'}),'剧场版');assert.equal(mediaType({Type:'剧场版'}),'剧场版');assert.equal(mediaType({Type:'ONA'}),'WEB');assert.equal(mediaType({Type:'OAD'}),'OAD');assert.equal(mediaType({Type:'OVA'}),'OVA');
});
test('seen through uses local chapter order, preserving later episodes and all extras',()=>{
  const work={EPDetails:{EP3:{LocalIndex:3,EpisodeNumber:28,Condition:'Watched'},EP1:{LocalIndex:1,EpisodeNumber:26},EP2:{LocalIndex:2,EpisodeNumber:27}},SPDetails:{SP1:{Condition:'Unwatched'}}};
  const changes=watchedThrough(work,'EP2');assert.deepEqual(changes,{'EPDetails.EP1.Condition':'Watched','EPDetails.EP2.Condition':'Watched'});
  assert.equal(work.EPDetails.EP3.Condition,'Watched');assert.equal(work.SPDetails.SP1.Condition,'Unwatched');assert.throws(()=>watchedThrough(work,'EP99'),/不存在/);
});
test('play uses the selected local version; comments use explicit Bangumi episode IDs only',()=>{
  const work={URL:path.resolve('media')};const slot={AbsolutePath:path.resolve('preferred.mkv'),Versions:[{path:path.resolve('other.mkv')}],EpisodeID:'12345'};
  assert.equal(episodePath(work,slot),slot.AbsolutePath);assert.equal(episodeLink(slot),'https://bgm.tv/ep/12345');
  assert.equal(episodeLink({EpisodeNumber:26}),null);assert.equal(episodePath(work,{URL:'video.mkv'}),path.resolve('media/video.mkv'));
});

test('original folder uses recorded source rather than the renamed media path',()=>{
 const {sourcePath}=require('../js/desktop-actions.cjs'),file=path.resolve('media/Show.mkv'),source=path.resolve('original/Raw.mkv');
 assert.equal(sourcePath({RenameBinding:{files:[{path:file,source}]}},file),source);
 assert.equal(sourcePath({EPDetails:{EP1:{Versions:[{path:file,source}]}}},file),source);
 assert.equal(sourcePath({RenameBinding:{files:[{path:file,source:'relative.mkv'}]}},file),null);
 assert.equal(sourcePath({RenameBinding:{files:[{path:file,source}]}},path.resolve('other.mkv')),null);
});

test('default chapter follows progress and ignores unavailable files and collections',()=>{
 const {defaultChapter}=require('../js/desktop-actions.cjs');
 const make=()=>({URL:'D:/Show',EPDetails:Object.fromEntries([1,2,3,4].map(i=>['EP'+i,{LocalIndex:i,EpisodeNumber:i,URL:i+'.mkv',Condition:'Unwatched'}]))});
 const work=make();assert.equal(defaultChapter(work),'EP1');
 work.EPDetails.EP2.Condition='Watched';assert.equal(defaultChapter(work),'EP3');
 work.RenameBinding={files:[{path:'D:/Show/3.mkv',availability:'missing'}]};assert.equal(defaultChapter(work),'EP4');
 work.EPDetails.EP4.Collection=true;assert.equal(defaultChapter(work),'EP1');
 for(const slot of Object.values(work.EPDetails))slot.Condition='Watched';assert.equal(defaultChapter(work),'EP2');
 work.EPDetails.EP1.availability='empty';work.EPDetails.EP2.availability='unreadable';assert.equal(defaultChapter(work),null);
 assert.equal(defaultChapter({}),null);
});
