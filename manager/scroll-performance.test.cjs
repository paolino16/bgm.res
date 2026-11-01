const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {handleHorizontalWheel}=require('../js/horizontal-scroll.cjs');const {mountCovers}=require('../js/library-rendering.cjs');
test('wheel escapes a row without overflow or at its edges, and respects native horizontal gestures',()=>{
  const row={scrollWidth:1000,clientWidth:300,scrollLeft:0};let prevented=0;const event={deltaY:100,deltaX:0,deltaMode:0,preventDefault(){prevented++;},target:row};
  assert.equal(handleHorizontalWheel({...event,deltaY:-100},row),false);assert.equal(prevented,0);
  assert.equal(handleHorizontalWheel(event,row),true);assert.equal(row.scrollLeft,100);assert.equal(prevented,1);
  row.scrollLeft=700;assert.equal(handleHorizontalWheel(event,row),false);
  row.scrollWidth=300;assert.equal(handleHorizontalWheel(event,row),false);
  row.scrollWidth=1000;row.scrollLeft=100;assert.equal(handleHorizontalWheel({...event,deltaX:150},row),false);
});
test('nested comments keep vertical scrolling and line wheel units remain usable',()=>{
  const row={scrollWidth:1000,clientWidth:300,scrollLeft:0};const child={parentElement:row,clientHeight:100,scrollHeight:200,ownerDocument:{defaultView:{getComputedStyle:()=>({overflowY:'auto'})}}};
  const event={deltaY:3,deltaX:0,deltaMode:1,preventDefault(){},target:child};assert.equal(handleHorizontalWheel(event,row),false);
  event.target=row;assert.equal(handleHorizontalWheel(event,row),true);assert.equal(row.scrollLeft,48);
});
test('cover loading is bounded to intersecting cards and reconnect disconnects the old observer',()=>{
  const cards=[{dataset:{cover:'file:///one.jpg'},style:{}},{dataset:{cover:'file:///two.jpg'},style:{}}];let callback,observed=0,removed=0,disconnected=0;
  class Observer{constructor(cb){callback=cb;}observe(){observed++;}unobserve(){removed++;}disconnect(){disconnected++;}}
  const container={querySelectorAll:()=>cards};mountCovers(container,Observer);assert.equal(observed,2);assert.equal(cards[1].style.backgroundImage,undefined);
  callback([{target:cards[0],isIntersecting:true},{target:cards[1],isIntersecting:false}]);assert.match(cards[0].style.backgroundImage,/one.jpg/);assert.equal(cards[1].style.backgroundImage,undefined);assert.equal(removed,1);
  mountCovers(container,Observer);assert.equal(disconnected,1);
});
test('332-work library renders once, retaining original card IDs and handlers',()=>{
  const source=fs.readFileSync(require.resolve('../renderer.js'),'utf8');const begin=source.indexOf('function ArchivePageInit(){'),end=source.indexOf('//! 媒体库-最近播放页面初始化模块',begin);const data={};
  for(let i=1;i<=332;i++)data['WorkSaveNo'+i]={Name:'Show '+i,ExistCondition:'Exist',EPTrueNum:1,EPDetails:{EP1:{Condition:'Unwatched'}},Cover:'file:///cover.jpg',Score:8,Year:2024,Type:'TV',Eps:1,Protocol:'P',Director:'D',Corp:'C'};
  let writes=0,mounts=0;const messages=[],container={};Object.defineProperty(container,'innerHTML',{get(){return this.html;},set(value){this.html=value;writes++;}});
  const settings={'Settings.checkboxC.LocalStorageMediaSortType':['Name','asc'],'Settings.checkboxC.LocalStorageMediaBaseNumber':332,'Settings.checkboxC.LocalStorageMediaBaseDeleteNumber':0};
  const context={document:{getElementById:id=>id==='ArchivePageContent'?container:{}},sysdata:{get:k=>settings[k]},store:{get:()=>data},SettingsColorPicker:()=>'',OKErrorStreamer:(...args)=>messages.push(args),$:()=>({eq:()=>({css(){}})}),nodeRequire:()=>({escapeAttribute:x=>x,mountCovers:c=>{assert.equal(c,container);mounts++;}})};
  vm.runInNewContext(source.slice(begin,end)+'\nArchivePageInit();',context);
  assert.equal(writes,2); // Clear the old view, then one complete insertion.
  assert.equal(mounts,1);assert.equal((container.html.match(/id='ArchiveWorkNo/g)||[]).length,332);assert.match(container.html,/ArchiveMediaDetailsPage\(332\)/);assert.ok(messages.length<=5);
});
