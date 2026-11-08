'use strict';
const {PAGE_SIZE}=require('./discovery.cjs');

// Share requests between a foreground page change and its background prefetch.
function pageSource(fetchPage){
  const pages=new Map();
  return offset=>{
    if(!pages.has(offset)){
      const pending=Promise.resolve().then(()=>fetchPage(offset)).catch(error=>{
        pages.delete(offset);throw error;
      });
      pages.set(offset,pending);
    }
    return pages.get(offset);
  };
}

function resultPages(read,eligible,{scanAhead=0}={}){
  const matches=[];
  let offset=0,more=true;
  return async (page,active,onScan)=>{
    const start=(page-1)*PAGE_SIZE;
    if(!eligible){
      let cursor=start,total;
      const rows=[];
      do{
        const batch=await read(cursor);
        if(!active())return null;
        total=batch.total;rows.push(...batch.rows);
        if(!batch.count){total=Math.min(total,cursor);break;}
        cursor+=batch.count;
        // Bangumi search may cap a request at 20 items even when we ask for 24.
      }while(cursor<start+PAGE_SIZE && cursor<total);
      return {rows:rows.slice(0,PAGE_SIZE),pages:Math.ceil(total/PAGE_SIZE),more:false};
    }
    while(more && matches.length<start+PAGE_SIZE && active()){
      const from=offset, batch=await read(from);
      if(!active())return null;
      // A rapid page change may have already consumed this batch.
      if(offset!==from)continue;
      matches.push(...batch.rows.filter(eligible));
      offset+=batch.count;more=batch.count>0 && offset<batch.total;
      // Fill a small shared request window only while more matches are needed.
      // Consume in source order, using the actual count when search caps batches.
      if(more && matches.length<start+PAGE_SIZE && active()){
        for(let i=0;i<scanAhead && offset+i*batch.count<batch.total;i++)
          void read(offset+i*batch.count).catch(()=>{});
      }
      if(more&&matches.length<=start)onScan?.(offset);
    }
    return {rows:matches.slice(start,start+PAGE_SIZE),pages:Math.ceil(matches.length/PAGE_SIZE),more};
  };
}
module.exports={pageSource,resultPages};
