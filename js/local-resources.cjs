const fs=require('fs');
const path=require('path');
function render({document,work,shell,onError}){
  const container=document.getElementById('ArchivePageContentDetailsEpisodeExtraBlock');
  container.replaceChildren();
  const files=work.RenameBinding.resources||[];
  const invalid=work.RenameBinding.invalidResources||[];
  if(invalid.length){const note=document.createElement('div');note.className='local-resource-note';note.textContent='已从有效文件列表排除 '+invalid.length+' 个空文件或失效文件（原文件保留）';container.appendChild(note);}
  if(!files.length){if(!invalid.length)container.textContent='没有特典文件';return;}
  for(const file of files){
    const row=document.createElement('div');row.className='local-resource';
    const name=document.createElement('div');name.className='local-resource-name';
    name.textContent=path.basename(file.path);name.title=file.path;row.appendChild(name);
    let available=false;try{available=fs.statSync(file.path).size>0;}catch{}
    const open=document.createElement('button');open.type='button';open.textContent=available?'打开文件':'文件缺失';open.disabled=!available;
    open.onclick=async()=>{try{const error=await shell.openPath(file.path);if(error)onError('无法打开文件：'+error);}catch(error){onError(error.message);}};
    const reveal=document.createElement('button');reveal.type='button';reveal.textContent='定位';reveal.disabled=!available;
    reveal.onclick=()=>{try{shell.showItemInFolder(file.path);}catch(error){onError(error.message);}};
    row.appendChild(open);row.appendChild(reveal);container.appendChild(row);
  }
}
module.exports={render};
