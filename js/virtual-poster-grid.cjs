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
function mount({root,viewport,items,renderItem,releaseItem,window,ResizeObserver}){
  const rows=new Map();let layout,rootTop=0,frame=0,destroyed=false;
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
      for(let item=index*layout.columns;item<end;item++)row.appendChild(renderItem(items[item],item));
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
    layout=next;const height=next.height+'px';if(root.style.height!==height)root.style.height=height;if(preserveAnchor)viewport.scrollTop=rootTop+(Math.floor(anchor/layout.columns)+fraction)*layout.stride;update();
  }
  const observer=new ResizeObserver(measure);observer.observe(root);observer.observe(viewport);
  viewport.addEventListener('scroll',schedule,{passive:true});root.addEventListener('focusout',schedule);
  measure();
  return {setItems(next){
    for(const [index,row]of rows){
      const start=index*layout.columns,end=Math.min(items.length,start+layout.columns);
      if(end-start!==Math.min(next.length,start+layout.columns)-start||items.slice(start,end).some((item,i)=>item!==next[start+i])){release(row);rows.delete(index);}
    }
    items=next;measure();
  },refresh(){measure({preserveAnchor:true});},destroy(){destroyed=true;observer.disconnect();viewport.removeEventListener('scroll',schedule);root.removeEventListener('focusout',schedule);if(frame)window.cancelAnimationFrame(frame);for(const row of rows.values())release(row);rows.clear();}};
}
module.exports={geometry,range,mount};
