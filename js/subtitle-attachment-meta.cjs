'use strict';
function metadata(file){
  let rest=String(file.note||'').split(file.name||'\0').join('').replace(/点击文件名下载附件/g,'');
  const stamp=rest.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*上传/);
  const size=rest.match(/\b(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|KB|MB|GB|bytes?|B|字节)(?![a-z])/i);
  const downloads=rest.match(/下载次数\s*[：:]\s*([\d,，]+)/);
  let uploaded='';
  if(stamp){uploaded=stamp[1]+'-'+stamp[2].padStart(2,'0')+'-'+stamp[3].padStart(2,'0')+' '+stamp[4].padStart(2,'0')+':'+stamp[5];rest=rest.replace(stamp[0],'');}
  let formattedSize='';
  if(size){const unit=size[2].toLowerCase(),units={b:'B',kb:'KB',mb:'MB',gb:'GB',kib:'KiB',mib:'MiB',gib:'GiB',byte:'字节',bytes:'字节'};formattedSize=size[1]+' '+(units[unit]||size[2]);rest=rest.replace(size[0],'');}
  if(downloads)rest=rest.replace(downloads[0],'');
  const count=downloads?downloads[1].replace(/[,，]/g,''):null;
  rest=rest.replace(/\([\s,，·]*\)|（[\s,，·]*）/g,'').replace(/^[\s,，·]+|[\s,，·]+$/g,'').trim();
  return {summary:[formattedSize,count!==null?'下载 '+count+' 次':''].filter(Boolean).join(' · '),uploaded,note:rest};
}
module.exports={metadata};
