function coarseWheel(event){
  if(event.deltaMode===1)return true;
  const value=Math.abs(event.deltaY);
  return event.deltaMode===0&&value>=40&&Number.isInteger(value)&&(value%40===0||value%50===0);
}
function install({element,window,duration=140}){
  let frame=0,target=0,start=0,started=0,written=0,direction=0,precisionUntil=0;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  function cancel(){if(frame)window.cancelAnimationFrame(frame);frame=0;direction=0;}
  function animate(now){
    if(Math.abs(element.scrollTop-written)>2){cancel();return;}
    const progress=Math.min(1,(now-started)/duration);
    written=start+(target-start)*(1-Math.pow(1-progress,3));element.scrollTop=written;
    if(progress<1)frame=window.requestAnimationFrame(animate);else{frame=0;direction=0;}
  }
  function wheel(event){
    if(event.defaultPrevented||event.ctrlKey||event.shiftKey||Math.abs(event.deltaX)>=Math.abs(event.deltaY)||reduced.matches){cancel();return;}
    for(let child=event.target;child&&child!==element;child=child.parentElement){
      if(['INPUT','TEXTAREA','SELECT'].includes(child.tagName)||child.isContentEditable){cancel();return;}
      if(child.scrollHeight>child.clientHeight+1&&['auto','scroll'].includes(window.getComputedStyle(child).overflowY)){cancel();return;}
    }
    const now=window.performance.now();
    if(!coarseWheel(event)){precisionUntil=now+250;cancel();return;}
    if(now<precisionUntil){cancel();return;}
    const delta=event.deltaY*(event.deltaMode===1?16:1),position=element.scrollTop,max=Math.max(0,element.scrollHeight-element.clientHeight);
    if(!max||Math.abs(delta)>element.clientHeight*1.5||(delta<0&&position<=0)||(delta>0&&position>=max)){cancel();return;}
    const sign=Math.sign(delta);
    const next=Math.max(0,Math.min(max,(frame&&sign===direction?target:position)+delta));
    event.preventDefault();
    if(frame&&next===target)return;
    cancel();direction=sign;
    target=next;start=position;written=position;started=now;
    frame=window.requestAnimationFrame(animate);
  }
  element.addEventListener('wheel',wheel,{passive:false});
  element.addEventListener('pointerdown',cancel,{passive:true});
  window.addEventListener('keydown',cancel);
  return {cancel,destroy(){cancel();element.removeEventListener('wheel',wheel);element.removeEventListener('pointerdown',cancel);window.removeEventListener('keydown',cancel);}};
}
module.exports={coarseWheel,install};
