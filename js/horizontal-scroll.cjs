function wheelDelta(event,width){return event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?width:1);}
function canMove(element,delta){const max=element.scrollWidth-element.clientWidth;return max>1&&(delta<0?element.scrollLeft>1:delta>0&&element.scrollLeft<max-1);}
function handleHorizontalWheel(event,element){
  if(event.defaultPrevented||event.ctrlKey||event.shiftKey||Math.abs(event.deltaX||0)>=Math.abs(event.deltaY||0))return false;
  // A nested comments pane keeps its own vertical scrolling.
  for(let child=event.target;child&&child!==element;child=child.parentElement){if(child.scrollHeight>child.clientHeight+1&&child.clientHeight>0){const overflow=child.ownerDocument?.defaultView?.getComputedStyle(child).overflowY;if(overflow==='auto'||overflow==='scroll')return false;}}
  const delta=wheelDelta(event,element.clientWidth);
  if(!canMove(element,delta))return false;
  event.preventDefault();element.scrollLeft+=delta;return true;
}
function install(document){for(const row of document.querySelectorAll('.ArchivePageContentDetailsPersonBlock,.ArchivePageContentDetailsFriends'))row.addEventListener('wheel',event=>handleHorizontalWheel(event,row),{passive:false});}
module.exports={canMove,handleHorizontalWheel,install,wheelDelta};
