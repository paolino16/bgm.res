const fs=require('fs/promises');
const {normalized}=require('./rename-binding-core.cjs');
async function inspect(group,previous,stat=fs.stat){
  const ignored=new Set((previous?.RenameBinding?.ignoredMissing||[]).map(normalized));
  const dismissed=new Set((previous?.RenameBinding?.dismissedResources||[]).map(file=>normalized(file.path)));
  const invalid=new Map((previous?.RenameBinding?.invalidResources||[]).map(file=>[normalized(file.path),file]));
  const knownExtras=new Set([...(previous?.RenameBinding?.resources||[]),...(previous?.RenameBinding?.invalidResources||[])].filter(file=>file.type==='extra'||Number(file.type)>=1).map(file=>normalized(file.path)));
  const files=await Promise.all(group.files.map(async file=>{
    let availability;
    try{const info=await stat(file.path);availability=!info.isFile()?'unreadable':info.size>0?'available':'empty';}
    catch(error){
      if(['ENOENT','ENOTDIR'].includes(error.code)){
        const old=invalid.get(normalized(file.path));
        availability=ignored.has(normalized(file.path))||knownExtras.has(normalized(file.path))||(old&&old.availability!=='missing')?'removed':'missing';
      }else availability='unreadable';
    }
    if(availability!=='available'&&dismissed.has(normalized(file.path)))availability='removed';
    return {...file,availability};
  }));
  return {...group,files};
}
module.exports={inspect};
