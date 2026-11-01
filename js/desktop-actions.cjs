const path=require('path');
function mediaType(work){
  const type=String(work.Type||'').trim();
  if(/剧场|movie|film/i.test(type))return '剧场版';
  if(/^tv$/i.test(type))return 'TV';
  if(/^oad$/i.test(type))return 'OAD';
  if(/^ova$/i.test(type))return 'OVA';
  if(/^(web|ona)$/i.test(type))return 'WEB';
  return '其他';
}
function watchedThrough(work,key){
  const chapters=Object.entries(work.EPDetails||{}).filter(([name])=>/^EP\d+$/.test(name)).sort((a,b)=>(a[1].LocalIndex||Number(a[0].slice(2)))-(b[1].LocalIndex||Number(b[0].slice(2))));
  const index=chapters.findIndex(([name])=>name===key);if(index<0)throw Error('章节不存在');
  return Object.fromEntries(chapters.slice(0,index+1).map(([name])=>['EPDetails.'+name+'.Condition','Watched']));
}
function episodePath(work,slot){return slot.AbsolutePath||slot.Versions?.[0]?.path||(slot.URL?path.resolve(work.URL,slot.URL):null);}
function episodeLink(slot){return /^[1-9]\d*$/.test(String(slot.EpisodeID||''))?'https://bgm.tv/ep/'+slot.EpisodeID:null;}
module.exports={mediaType,watchedThrough,episodePath,episodeLink};
