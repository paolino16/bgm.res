function specialWatched(work,id){
  const saved=work.SpecialEpisodeStates?.[String(id)];if(saved)return saved==='Watched';
  return [...Object.values(work.SPDetails||{}),...(work.RenameBinding?.resources||[])].some(row=>String(row.EpisodeID||row.episodeId)===String(id)&&row.Condition==='Watched');
}
function specialThrough(group,id){const index=group.rows.findIndex(row=>String(row.id)===String(id));if(index<0)throw Error('特别章节不存在');return Object.fromEntries(group.rows.slice(0,index+1).map(row=>['SpecialEpisodeStates.'+row.id,'Watched']));}
function specialToggle(work,id){if(!/^[1-9]\d*$/.test(String(id)))throw Error('章节编号无效');return {['SpecialEpisodeStates.'+id]:specialWatched(work,id)?'Unwatched':'Watched'};}
module.exports={specialWatched,specialThrough,specialToggle};
