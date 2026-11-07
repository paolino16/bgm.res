function geometry(width,minWidth,columnGap,rowGap,count,extraHeight=0){
  const columns=Math.max(1,Math.floor((width+columnGap)/(minWidth+columnGap)));
  const cardWidth=(width-columnGap*(columns-1))/columns;
  const cardHeight=cardWidth*1.5+79+extraHeight;
  const rows=Math.ceil(count/columns);
  return {columns,cardHeight,stride:cardHeight+rowGap,rows,height:Math.max(0,rows*(cardHeight+rowGap)-rowGap)};
}
function range(scrollTop,rootTop,viewportHeight,stride,rows){
  if(!rows)return {start:0,end:0};
  const offset=Math.max(0,scrollTop-rootTop);
  return {start:Math.max(0,Math.min(rows-1,Math.floor(offset/stride)-1)),end:Math.min(rows,Math.ceil((offset+viewportHeight)/stride)+1)};
}
function mount({root,viewport,items,renderItem,releaseItem,onCommit=()=>{},window,ResizeObserver}){
  const rows=new Map();let layout,rootTop=0,frame=0,destroyed=false,reusable,cancelPreparation,requestedItems=items;
  function release(row){releaseItem(row);row.remove();}
  function update(){
    frame=0;if(destroyed||!layout)return;
    const visible=range(viewport.scrollTop,rootTop,viewport.clientHeight,layout.stride,layout.rows);
    for(const [index,row]of rows){if((index<visible.start||index>=visible.end)&&!row.contains(root.ownerDocument.activeElement)){release(row);rows.delete(index);}}
    for(let index=visible.start;index<visible.end;index++){
      if(rows.has(index))continue;
      const row=root.ownerDocument.createElement('div');row.className='virtual-poster-row';
      row.style.top=(index*layout.stride)+'px';row.style.height=layout.cardHeight+'px';
      row.style.gridTemplateColumns=`repeat(${layout.columns},minmax(0,1fr))`;
      const end=Math.min(items.length,(index+1)*layout.columns);
      for(let item=index*layout.columns;item<end;item++){
        const value=items[item],card=reusable?.get(value)||renderItem(value,item);
        reusable?.delete(value);row.appendChild(card);
      }
      const next=[...rows.keys()].filter(other=>other>index).sort((a,b)=>a-b)[0];
      root.insertBefore(row,rows.get(next)||null);rows.set(index,row);
    }
  }
  function schedule(){if(!frame&&!destroyed)frame=window.requestAnimationFrame(update);}
  function measure({preserveAnchor=false}={}){
    if(destroyed)return;
    const offset=layout?Math.max(0,viewport.scrollTop-rootTop):0;const anchor=layout?Math.floor(offset/layout.stride)*layout.columns:0;const fraction=layout?(offset%layout.stride)/layout.stride:0;
    const style=window.getComputedStyle(root);
    const next=geometry(root.clientWidth,parseFloat(style.getPropertyValue('--poster-min'))||152,parseFloat(style.columnGap)||20,parseFloat(style.rowGap)||26,items.length,parseFloat(style.getPropertyValue('--poster-extra'))||0);
    rootTop=root.getBoundingClientRect().top-viewport.getBoundingClientRect().top+viewport.scrollTop;
    if(!layout||next.columns!==layout.columns||Math.abs(next.cardHeight-layout.cardHeight)>.1){for(const row of rows.values())release(row);rows.clear();}
    layout=next;const height=!next.rows&&root.children.length?'':next.height+'px';if(root.style.height!==height)root.style.height=height;if(preserveAnchor)viewport.scrollTop=rootTop+(Math.floor(anchor/layout.columns)+fraction)*layout.stride;update();
  }
  const observer=new ResizeObserver(measure);observer.observe(root);observer.observe(viewport);
  viewport.addEventListener('scroll',schedule,{passive:true});root.addEventListener('focusout',schedule);
  measure();
  function applyItems(next,prepared=new Map()){
    const retired=[];reusable=new Map(prepared);
    for(const [index,row]of rows){
      const start=index*layout.columns,end=Math.min(items.length,start+layout.columns);
      if(end-start!==Math.min(next.length,start+layout.columns)-start||items.slice(start,end).some((item,i)=>item!==next[start+i])){
        [...row.children].forEach((card,i)=>reusable.set(items[start+i],card));
        retired.push(row);row.remove();rows.delete(index);
      }
    }
    // Move existing cards with their decoded images before releasing discarded ones.
    // All row changes happen in the same task, so no empty grid is painted between them.
    try{onCommit();items=next;measure();}finally{
      for(const row of retired)releaseItem(row);
      for(const [value,card]of prepared)if(reusable.has(value))releaseItem(card);
      reusable=null;
    }
  }
  return {setItems(next){
    cancelPreparation?.();
    if(destroyed)return;
    requestedItems=next;
    const mounted=new Set();for(const [index,row]of rows)for(let i=0;i<row.children.length;i++)mounted.add(items[index*layout.columns+i]);
    const visible=range(viewport.scrollTop,rootTop,viewport.clientHeight,layout.stride,Math.ceil(next.length/layout.columns));
    const prepared=new Map(),loading=[];
    for(let i=visible.start*layout.columns;i<Math.min(next.length,visible.end*layout.columns);i++){
      if(mounted.has(next[i]))continue;
      const card=renderItem(next[i],i);prepared.set(next[i],card);
      for(const img of card.querySelectorAll?.('img')||[])if(img.decode&&(!img.complete||!img.naturalWidth))loading.push(img.decode().catch(()=>{}));
    }
    if(!loading.length){applyItems(next,prepared);return;}
    // Keep the current grid painted until the incoming covers can be displayed.
    // Slow/unreachable covers must not block filtering indefinitely.
    let settled=false,timer;
    const cancel=()=>{if(settled)return;settled=true;window.clearTimeout(timer);for(const card of prepared.values())releaseItem(card);cancelPreparation=null;};
    const commit=()=>{if(settled)return;settled=true;window.clearTimeout(timer);cancelPreparation=null;applyItems(next,prepared);};
    cancelPreparation=cancel;
    timer=window.setTimeout(commit,1500);
    return Promise.all(loading).then(commit);
  },refresh(){cancelPreparation?.();measure({preserveAnchor:true});if(requestedItems!==items)this.setItems(requestedItems);},destroy(){cancelPreparation?.();destroyed=true;observer.disconnect();viewport.removeEventListener('scroll',schedule);root.removeEventListener('focusout',schedule);if(frame)window.cancelAnimationFrame(frame);for(const row of rows.values())release(row);rows.clear();}};
}
module.exports={geometry,range,mount};
