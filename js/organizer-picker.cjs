const subtitleExtensions=['ass','ssa','srt','vtt','sub','idx','sup','smi','sami','ttml'];
function optionsFor(kind){
  if(kind==='subtitle-files')return {title:'选择字幕文件（可多选）',properties:['openFile','multiSelections'],filters:[{name:'字幕文件',extensions:subtitleExtensions}]};
  if(kind==='subtitle-folder')return {title:'选择字幕目录',properties:['openDirectory']};
  if(kind==='file')return {title:'选择视频文件',properties:['openFile','multiSelections']};
  if(kind==='folder')return {title:'选择整理目录',properties:['openDirectory','multiSelections']};
  throw Error('不支持的文件选择类型');
}
module.exports={optionsFor,subtitleExtensions};
