'use strict';
const path=require('node:path');
const languages={chs:'简中',cht:'繁中',sc:'简中',tc:'繁中',jpsc:'简日',jptc:'繁日',zh:'中文',ja:'日语',jpn:'日语',en:'英语',eng:'英语'};
function label(suffix){const parts=String(suffix||'').split('.');return suffix?[languages[parts[0].toLowerCase()]||parts[0],...parts.slice(1)].join(' · '):'未命名版本';}
function groups(report){
  const result=new Map();
  for(const file of report?.files||[])for(const value of file.external||[]){
    const suffix=path.basename(value,path.extname(value)).slice(path.basename(file.path,path.extname(file.path)).length).replace(/^\./,'');
    const id=suffix.toLowerCase();if(!result.has(id))result.set(id,{id,suffix,files:[],videos:[],formats:[]});const group=result.get(id);
    group.files.push({path:value,video:file.path});if(!group.videos.includes(file.path))group.videos.push(file.path);const format=path.extname(value).slice(1).toUpperCase();if(!group.formats.includes(format))group.formats.push(format);
  }
  return [...result.values()];
}
function coverage(videos,context,report){
  const selected=new Set(videos.map(value=>path.resolve(value).toLowerCase())),chapters=context?.chapters||[];
  if(chapters.length){const covered=chapters.filter(chapter=>chapter.videos.some(video=>selected.has(path.resolve(video).toLowerCase()))).length;return covered+' / '+chapters.length+' 集'+(videos.length>covered?' · '+videos.length+' 个视频版本':'');}
  return videos.length+' / '+(report?.files?.length||0)+' 个视频版本';
}
module.exports={label,groups,coverage};
