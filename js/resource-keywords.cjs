'use strict';

// Conservative shortlist from positive community feedback and historical
// technical recommendations. Popularity or release speed alone is not enough.
// Historical reputation does not guarantee every release's quality. Keep
// ambiguous names (sam, PL, home) out of ordinary title matching.
// ReinForce is explicitly included for the user's preference for source-like video.
const groups = [
  ['VCB-Studio', 'VCB-S', 'VCB'], ['Snow-Raws'], ['Beatrice-Raws'],
  ['jsum'], ['ReinForce'], ['mawen1250'], ['LittleBakas!', 'LittleBakas'],
  ['philosophy-raws', 'fch1993'], ['Kagura'],
  ['Fussoir', 'Firesledge'], ['ANE'], ['Henshin'], ['THORA', 'THORAnime'],
  ['NanoAlchemist'], ['sergey_krs'], ['Yousei-raws'],
  ['Kaleido-subs', 'Kaleido'], ['LoliHouse']
];
const escape = value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function normalizeKeywords(value) {
  const entries=Array.isArray(value)?value:typeof value==='string'?value.split(/[\n\r,，;；]+/):[];
  const seen=new Set();
  return entries.filter(entry=>typeof entry==='string').map(entry=>entry.trim()).filter(entry=>{
    const key=entry.toLowerCase();
    if(!key||seen.has(key))return false;
    seen.add(key);return true;
  });
}

function defaultKeywords(){return groups.flat();}
function loadKeywords(storage){
  try{
    const saved=JSON.parse(storage.getItem('resource-highlight-keywords'));
    if(Array.isArray(saved))return normalizeKeywords(saved);
  }catch{}
  let legacy=[];
  try{legacy=normalizeKeywords(JSON.parse(storage.getItem('resource-custom-keywords')));}catch{}
  return normalizeKeywords([...defaultKeywords(),...legacy]);
}
function createMatcher(keywords=defaultKeywords()) {
  const patterns=normalizeKeywords(keywords).map(alias=>alias.split(/[-_ ]+/).map(escape).join('[-_ ]+'));
  if(!patterns.length)return title=>[{text:String(title??'')}];
  patterns.sort((a,b)=>b.length-a.length);
  const pattern=new RegExp('(?<![a-z0-9])(?:'+patterns.join('|')+')(?![a-z0-9])','gi');
  return title=>splitTitle(title,pattern);
}
function splitTitle(title,pattern) {
  const text=String(title??''), parts=[];
  let offset=0;
  for(const match of text.matchAll(pattern)){
    if(match.index>offset)parts.push({text:text.slice(offset,match.index)});
    parts.push({text:match[0],highlight:true});
    offset=match.index+match[0].length;
  }
  if(offset<text.length)parts.push({text:text.slice(offset)});
  return parts;
}
const titleParts=createMatcher();

function highlightTitle(element,title,node,matcher=titleParts) {
  const parts=matcher(title);
  if(!parts.some(part=>part.highlight))return;
  element.replaceChildren(...parts.map(part=>{
    const item=node(part.highlight?'mark':'span',part.highlight?'resource-keyword':'',part.text);
    if(part.highlight)item.title='高亮名单中的关键词；与 SeaDex 具体版本推荐无关';
    return item;
  }));
}

module.exports={titleParts,highlightTitle,createMatcher,normalizeKeywords,defaultKeywords,loadKeywords};
