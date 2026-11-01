const {test}=require('node:test');
const assert=require('node:assert/strict');
const {install,coarseWheel}=require('../js/smooth-scroll.cjs');
function setup(){
  let now=0,id=0;const pending=new Map(),listeners=new Map(),reduced={matches:false};
  const element={scrollTop:200,scrollHeight:2000,clientHeight:500,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const window={matchMedia:()=>reduced,performance:{now:()=>now},requestAnimationFrame:fn=>{pending.set(++id,fn);return id;},cancelAnimationFrame:key=>pending.delete(key),addEventListener(){},removeEventListener(){},getComputedStyle:()=>({overflowY:'auto'})};
  const controller=install({element,window});
  function wheel(deltaY,extra={}){const event={deltaY,deltaX:0,deltaMode:0,target:element,prevented:false,preventDefault(){this.prevented=true;},...extra};listeners.get('wheel')(event);return event;}
  function tick(time){now=time;const callbacks=[...pending.values()];pending.clear();callbacks.forEach(fn=>fn(time));}
  return {element,pending,controller,wheel,tick,reduced};
}
test('coarse wheel moves through intermediate positions and combines ticks without a long tail',()=>{
  const h=setup();assert.equal(h.wheel(120).prevented,true);assert.equal(h.element.scrollTop,200);
  h.wheel(120);assert.equal(h.pending.size,1);
  h.tick(70);assert.ok(h.element.scrollTop>200&&h.element.scrollTop<440);
  h.tick(140);assert.equal(h.element.scrollTop,440);assert.equal(h.pending.size,0);
});
test('reversing direction follows the new gesture immediately and navigation cancels animation',()=>{
  const h=setup();h.wheel(120);h.tick(50);const before=h.element.scrollTop;
  h.wheel(-120);h.tick(190);assert.equal(h.element.scrollTop,before-120);
  h.wheel(120);h.controller.cancel();assert.equal(h.pending.size,0);
});
test('precision gestures, edges, nested scroll panes and reduced motion retain native scrolling',()=>{
  assert.equal(coarseWheel({deltaY:120,deltaMode:0}),true);assert.equal(coarseWheel({deltaY:3,deltaMode:1}),true);
  const h=setup();assert.equal(h.wheel(2.5).prevented,false);assert.equal(h.wheel(120).prevented,false);
  h.tick(300);h.element.scrollTop=1500;assert.equal(h.wheel(120).prevented,false);
  h.element.scrollTop=200;assert.equal(h.wheel(10000).prevented,false);
  assert.equal(h.wheel(120,{target:{tagName:'DIV',scrollHeight:200,clientHeight:100,parentElement:h.element}}).prevented,false);
  h.reduced.matches=true;assert.equal(h.wheel(120).prevented,false);assert.equal(h.pending.size,0);
});
