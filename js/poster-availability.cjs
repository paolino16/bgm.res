// No usable local regular video, rather than an incomplete episode catalogue.
function hasMissingRegular(work){
  if(!work.EPDetails&&!work.RenameBinding)return false;
  const files=work.RenameBinding?.files||[];
  const usable=file=>!file.availability||file.availability==='available';
  const key=value=>String(value||'').replaceAll('\\','/').toLowerCase();
  const byPath=new Map(files.map(file=>[key(file.path),file]));
  if(Object.values(work.EPDetails||{}).some(slot=>(slot.Versions||[{path:slot.AbsolutePath||slot.URL}]).some(file=>file.path&&usable(byPath.get(key(file.path))||file))))return false;
  return !files.some(file=>file.path&&(file.type===0||file.collection)&&usable(file));
}
module.exports={hasMissingRegular};
