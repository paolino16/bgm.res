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
function subtitleGroup(work,file){
  if(!file)return '';
  const identity=path.resolve(file).toLowerCase();
  const rows=[...(work.RenameBinding?.files||[]),...['EPDetails','SPDetails'].flatMap(kind=>Object.values(work[kind]||{}).flatMap(slot=>slot.Versions||[]))];
  const recorded=rows.find(row=>row.path&&path.resolve(row.path).toLowerCase()===identity&&row.subtitleGroup)?.subtitleGroup;
  return String(recorded||path.basename(file,path.extname(file)).match(/\[([^\]]+)\]$/)?.[1]||'').trim();
}
function preferredVersion(work,files){
  const group=String(work.DefaultSubtitleGroup||'').trim().toLowerCase();
  if(!group)return null;
  return files.find(file=>{
    if(!file.path)return false;
    const record=work.RenameBinding?.files?.find(row=>row.path&&path.resolve(row.path).toLowerCase()===path.resolve(file.path).toLowerCase());
    const status=file.availability||record?.availability;
    return (!status||status==='available')&&subtitleGroup(work,file.path).toLowerCase()===group;
  })?.path||null;
}
function episodePath(work,slot){return preferredVersion(work,slot.Versions||[])||slot.AbsolutePath||slot.Versions?.[0]?.path||(slot.URL?path.resolve(work.URL,slot.URL):null);}
function defaultChapter(work){
  const known=new Map((work.RenameBinding?.files||[]).map(file=>[path.resolve(file.path).toLowerCase(),file.availability]));
  const chapters=Object.entries(work.EPDetails||{}).filter(([,slot])=>!slot.Collection&&(slot.EpisodeType==null||Number(slot.EpisodeType)===0))
    .sort((a,b)=>(a[1].EpisodeNumber??a[1].LocalIndex??0)-(b[1].EpisodeNumber??b[1].LocalIndex??0));
  const usable=slot=>(slot.Versions?.length?slot.Versions:[{path:episodePath(work,slot)}]).some(file=>{
    if(!file.path)return false;const status=file.availability||known.get(path.resolve(file.path).toLowerCase())||slot.availability;
    return !status||status==='available';
  });
  const lastWatched=chapters.reduce((last,[,slot],i)=>slot.Condition==='Watched'?i:last,-1);
  return (chapters.find(([,slot],i)=>i>lastWatched&&slot.Condition!=='Watched'&&usable(slot))
    ||chapters.find(([,slot])=>slot.Condition!=='Watched'&&usable(slot))
    ||chapters.filter(([,slot])=>usable(slot)).at(-1))?.[0]||null;
}
function episodeLink(slot){return /^[1-9]\d*$/.test(String(slot.EpisodeID||''))?'https://bgm.tv/ep/'+slot.EpisodeID:null;}
function sourcePath(work,file){
  const identity=path.resolve(file).toLowerCase();
  const rows=[...(work.RenameBinding?.files||[]),...['EPDetails','SPDetails'].flatMap(kind=>Object.values(work[kind]||{}).flatMap(slot=>slot.Versions||[]))];
  const source=rows.find(row=>row.path&&path.resolve(row.path).toLowerCase()===identity&&row.source)?.source;
  return typeof source==='string'&&path.isAbsolute(source)?source:null;
}
module.exports={defaultChapter,mediaType,watchedThrough,episodePath,episodeLink,sourcePath,subtitleGroup,preferredVersion};
