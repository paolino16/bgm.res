const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {mediaType,watchedThrough,episodePath,episodeLink}=require('../js/desktop-actions.cjs');
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
