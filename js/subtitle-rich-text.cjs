'use strict';
const tags=new Set(['p','div','br','strong','em','u','s','ul','ol','li','blockquote','pre','code','table','caption','thead','tbody','tfoot','tr','th','td','h4']);
function render(host,nodes){
  const document=host.ownerDocument;
  let count=0,remaining=60000;
  function append(parent,items,depth=0){
    if(!Array.isArray(items)||depth>32)return;
    for(const item of items){
      if(++count>4000||remaining<=0)return;
      if(typeof item==='string'){
        const value=item.replace(/\uFEFF/g,'').slice(0,remaining);remaining-=value.length;parent.appendChild(document.createTextNode(value));continue;
      }
      if(!item||!tags.has(item.tag))continue;
      const element=document.createElement(item.tag);
      if(item.tag==='td'||item.tag==='th')for(const attr of ['colspan','rowspan'])if(Number.isInteger(item[attr])&&item[attr]>1&&item[attr]<=50)element.setAttribute(attr,item[attr]);
      if(item.tag==='table'){
        const scroll=document.createElement('div');scroll.className='subtitle-table-scroll';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','字幕说明表格');scroll.appendChild(element);parent.appendChild(scroll);
      }else parent.appendChild(element);
      // Also tolerate malformed trees already cached before normalization.
      append(item.tag==='br'?parent:element,item.children,depth+1);
    }
  }
  host.classList.add('subtitle-rich-text');append(host,nodes);
}
module.exports={render};
