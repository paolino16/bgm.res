// Aggregate frame timing only; no titles, account details or media paths.
function install({document,window}){
  let active=false,lastScroll=0,lastFrame=0,deltas=[],surface='',events=0;
  const frame=now=>{
    if(lastFrame)deltas.push(now-lastFrame);lastFrame=now;
    if(now-lastScroll<250){window.requestAnimationFrame(frame);return;}
    active=false;if(deltas.length<3)return;
    const sorted=deltas.slice().sort((a,b)=>a-b);
    const metrics={at:new Date().toISOString(),surface,frames:deltas.length,events,p95:Math.round(sorted[Math.floor(sorted.length*.95)]),worst:Math.round(sorted[sorted.length-1]),over33:deltas.filter(v=>v>33.4).length};
    require('fs').appendFileSync(require('path').join(process.env.BGM_RES_DATA_DIR,'scroll-metrics.jsonl'),JSON.stringify(metrics)+'\n');
  };
  document.addEventListener('scroll',event=>{
    const id=event.target.id;if(!['ArchivePageContent','ArchivePageContentDetails'].includes(id))return;
    lastScroll=window.performance.now();events++;
    if(!active){active=true;surface=id;events=1;lastFrame=0;deltas=[];window.requestAnimationFrame(frame);}
  },{capture:true,passive:true});
}
module.exports={install};
