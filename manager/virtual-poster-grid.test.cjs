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
  let resizeCallback,disconnected=false,released=0,created=0;const pending=new Map();let sequence=0;
  const document={activeElement:null,createElement(){return element();}};
  function element(){return {ownerDocument:document,children:[],style:{},listeners:new Map(),clientWidth:1100,clientHeight:600,scrollTop:0,
    appendChild(child){this.insertBefore(child,null);},insertBefore(child,next){child.parent=this;const i=this.children.indexOf(next);this.children.splice(i<0?this.children.length:i,0,child);},
    remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);},contains(){return false;},
    addEventListener(name,fn){this.listeners.set(name,fn);},removeEventListener(name){this.listeners.delete(name);},getBoundingClientRect(){return {top:this===root?24-viewport.scrollTop:0};}};}
  const root=element(),viewport=element();
  const window={getComputedStyle:()=>({getPropertyValue:()=>152,columnGap:'20px',rowGap:'26px'}),requestAnimationFrame(fn){pending.set(++sequence,fn);return sequence;},cancelAnimationFrame(id){pending.delete(id);}};
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
  instance.destroy();assert.equal(root.children.length,0);assert.equal(disconnected,true);assert.equal(viewport.listeners.has('scroll'),false);
});
