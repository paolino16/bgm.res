const {test}=require('node:test');
const assert=require('node:assert/strict');
const {geometry,range,mount}=require('../js/virtual-poster-grid.cjs');
test('virtual rows cover the final partial row without a height jump',()=>{
  const layout=geometry(1100,152,20,26,332);
  assert.equal(layout.columns,6);assert.equal(layout.rows,56);
  assert.equal(layout.height,layout.rows*layout.stride-26);
  const end=range(layout.height-600,24,600,layout.stride,layout.rows);
  assert.equal(end.end,56);assert.ok(end.start<end.end);
  assert.deepEqual(range(0,24,600,layout.stride,0),{start:0,end:0});
});
test('mount keeps only nearby cards, batches scroll events, and releases rows on navigation',()=>{
  let resizeCallback,disconnected=false,released=0,created=0,minimum=152;const pending=new Map();let sequence=0;
  const document={activeElement:null,createElement(){return element();}};
  function element(){return {ownerDocument:document,children:[],style:{},listeners:new Map(),clientWidth:1100,clientHeight:600,scrollTop:0,
    appendChild(child){this.insertBefore(child,null);},insertBefore(child,next){child.remove();child.parent=this;const i=this.children.indexOf(next);this.children.splice(i<0?this.children.length:i,0,child);},
    remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;},contains(){return false;},
    addEventListener(name,fn){this.listeners.set(name,fn);},removeEventListener(name){this.listeners.delete(name);},getBoundingClientRect(){return {top:this===root?24-viewport.scrollTop:0};}};}
  const root=element(),viewport=element();
  const window={getComputedStyle:()=>({getPropertyValue:name=>name==='--poster-min'?minimum:0,columnGap:'20px',rowGap:'26px'}),requestAnimationFrame(fn){pending.set(++sequence,fn);return sequence;},cancelAnimationFrame(id){pending.delete(id);}};
  class Observer{constructor(fn){resizeCallback=fn;}observe(){}disconnect(){disconnected=true;}}
  const instance=mount({root,viewport,items:Array.from({length:332},(_,i)=>i),renderItem:i=>{created++;const el=element();el.item=i;return el;},releaseItem:()=>released++,window,ResizeObserver:Observer});
  const count=()=>root.children.reduce((n,row)=>n+row.children.length,0);
  assert.ok(count()<=24);assert.ok(created<332);
  viewport.scrollTop=10000;for(let i=0;i<10;i++)viewport.listeners.get('scroll')();assert.equal(pending.size,1);
  for(const [id,fn]of pending){pending.delete(id);fn();}
  assert.ok(count()<=24);assert.ok(released>0);assert.ok(root.children[0].children[0].item>100);
  viewport.scrollTop=9500;viewport.listeners.get('scroll')();for(const [id,fn]of pending){pending.delete(id);fn();}
  const ordered=root.children.map(row=>row.children[0].item);assert.deepEqual(ordered,[...ordered].sort((a,b)=>a-b));
  root.clientWidth=800;resizeCallback();assert.ok(count()<=20);
  const oldLayout=geometry(root.clientWidth,minimum,20,26,332);const visibleIndex=Math.floor((viewport.scrollTop-24)/oldLayout.stride)*oldLayout.columns;minimum=240;instance.refresh();assert.ok(viewport.scrollTop>0);assert.ok(root.children.some(row=>row.children.some(card=>card.item===visibleIndex)));assert.ok(count()<=20);
  const same=root.children[0],before=created;
  instance.setItems(Array.from({length:332},(_,i)=>i));assert.equal(root.children[0],same);assert.equal(created,before);
  const changed=Array.from({length:332},(_,i)=>i);changed[same.children[0].item]=-1;
  instance.setItems(changed);assert.notEqual(root.children[0],same);assert.ok(root.children[0].children.some(card=>card.item===-1));
  instance.setItems([]);assert.equal(root.children.length,0);assert.equal(root.style.height,'0px');
  instance.setItems([100,101]);assert.equal(count(),2);
  const retained=root.children[0].children[1],createdBefore=created;
  retained.decodedImage={src:'already-loaded-cover'};
  instance.setItems([101,102]);assert.equal(root.children[0].children[0],retained);assert.equal(created,createdBefore+1);assert.equal(retained.decodedImage.src,'already-loaded-cover');
  const reordered=root.children[0].children.slice();instance.setItems([102,101]);assert.equal(root.children[0].children[0],reordered[1]);assert.equal(root.children[0].children[1],reordered[0]);assert.equal(created,createdBefore+1);
  instance.destroy();assert.equal(root.children.length,0);assert.equal(disconnected,true);assert.equal(viewport.listeners.has('scroll'),false);
});

test('filter waits for decoded covers, cancels obsolete requests, and bounds slow images',async()=>{
 const document={activeElement:null,createElement:()=>element()},timers=new Map(),decoders=new Map(),released=[];let sequence=0;
 function element(){return {ownerDocument:document,children:[],style:{},clientWidth:400,clientHeight:400,scrollTop:0,
  appendChild(child){this.insertBefore(child,null);},insertBefore(child,next){child.remove();child.parent=this;const index=this.children.indexOf(next);this.children.splice(index<0?this.children.length:index,0,child);},
  remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;},contains(){return false;},addEventListener(){},removeEventListener(){},getBoundingClientRect(){return {top:0};}};}
 const root=element(),viewport=element();
 const window={getComputedStyle:()=>({getPropertyValue:()=>152,columnGap:'20',rowGap:'26'}),requestAnimationFrame(){},cancelAnimationFrame(){},setTimeout(fn){timers.set(++sequence,fn);return sequence;},clearTimeout(id){timers.delete(id);}};
 const instance=mount({root,viewport,items:['old'],renderItem:item=>{const card=element();card.item=item;card.querySelectorAll=()=>item==='old'?[]:[{complete:false,decode:()=>new Promise(resolve=>decoders.set(item,resolve))}];return card;},releaseItem:card=>released.push(card),window,ResizeObserver:class{observe(){}disconnect(){}}});
 const old=root.children[0].children[0];
 const pending=instance.setItems(['first']);assert.equal(root.children[0].children[0],old);
 const latest=instance.setItems(['latest']);decoders.get('first')();await pending;assert.equal(root.children[0].children[0],old);
 decoders.get('latest')();await latest;assert.equal(root.children[0].children[0].item,'latest');assert.ok(released.some(card=>card.item==='first'));assert.equal(timers.size,0);
 const slow=instance.setItems(['slow']);assert.equal(root.children[0].children[0].item,'latest');[...timers.values()][0]();assert.equal(root.children[0].children[0].item,'slow');decoders.get('slow')();await slow;
 const closing=instance.setItems(['closing']);instance.destroy();decoders.get('closing')();await closing;assert.equal(root.children.length,0);assert.equal(timers.size,0);
});
