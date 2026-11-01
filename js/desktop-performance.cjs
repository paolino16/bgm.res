// Opt-in local diagnostics. No titles, paths, account data or continuous logging.
function install({document,window}){
  const fs=require('fs'),path=require('path');
  const directory=process.env.BGM_RES_DATA_DIR;
  if(!directory||!fs.existsSync(path.join(directory,'performance-profile.enabled')))return;
  const filename=path.join(directory,'desktop-scroll-profile.jsonl');
  const write=value=>fs.promises.appendFile(filename,JSON.stringify({at:new Date().toISOString(),...value})+'\n').catch(()=>{});
  let gpu;try{gpu=require('@electron/remote').app.getGPUFeatureStatus();}catch{}
  write({kind:'environment',width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio,gpu});
  let active=false,last=0,previous=0,frames=[],events=0,longTasks=0,shifts=0;
  try{new window.PerformanceObserver(list=>{if(active)longTasks+=list.getEntries().length;}).observe({type:'longtask',buffered:false});}catch{}
  try{new window.PerformanceObserver(list=>{if(active)shifts+=list.getEntries().filter(e=>e.value>0).length;}).observe({type:'layout-shift',buffered:false});}catch{}
  const frame=now=>{
    if(previous)frames.push(now-previous);previous=now;
    if(now-last<180){window.requestAnimationFrame(frame);return;}
    active=false;if(frames.length<2)return;
    const sorted=frames.slice().sort((a,b)=>a-b);
    const images=[...document.querySelectorAll('.content img')].filter(el=>el.complete&&el.naturalWidth);
    write({kind:'scroll',mode:document.querySelector('.library-grid')?'grid':document.querySelector('.library-list')?'list':'detail',events,frames:frames.length,p95:Math.round(sorted[Math.floor(sorted.length*.95)]),worst:Math.round(sorted.at(-1)),over25:frames.filter(v=>v>25).length,longTasks,shifts,mountedCards:document.querySelectorAll('.work-card').length,mountedRows:document.querySelectorAll('.virtual-poster-row').length,loadedImages:images.length,decodedMB:Math.round(images.reduce((n,img)=>n+img.naturalWidth*img.naturalHeight*4,0)/1048576)});
  };
  document.getElementById('content').addEventListener('scroll',()=>{
    last=window.performance.now();events++;
    if(!active){active=true;previous=0;frames=[];events=1;longTasks=0;shifts=0;window.requestAnimationFrame(frame);}
  },{passive:true});
}
module.exports={install};
