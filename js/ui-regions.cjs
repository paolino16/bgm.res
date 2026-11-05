// Keep unchanged nodes mounted; moving focus-bearing controls is unnecessary.
function reconcileChildren(host,children){
  const keep=new Set(children);
  for(const child of [...host.children])if(!keep.has(child))child.remove();
  for(let i=0;i<children.length;i++)if(host.children[i]!==children[i])host.insertBefore(children[i],host.children[i]||null);
}
function preserveInteraction(host,update){
  const doc=host.ownerDocument,active=doc?.activeElement;
  const controls=()=>[...host.querySelectorAll('input,select,textarea,button')];
  const index=active&&host.contains(active)?controls().indexOf(active):-1;
  const key=index>=0?(active.getAttribute('aria-label')||active.name||active.id):null;
  const selection=active&&typeof active.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null;
  const viewport=host.closest?.('#content'),scroll=viewport?.scrollTop;
  update();
  if(index>=0&&!active.isConnected){
    const candidates=controls(),next=key?candidates.find(el=>(el.getAttribute('aria-label')||el.name||el.id)===key):candidates[index];
    if(next&&!next.disabled){next.focus({preventScroll:true});if(selection&&next.setSelectionRange)try{next.setSelectionRange(...selection);}catch{}}
  }
  if(viewport)viewport.scrollTop=scroll;
}
module.exports={reconcileChildren,preserveInteraction};
