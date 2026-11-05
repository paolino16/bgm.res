const {test}=require('node:test'),assert=require('node:assert/strict');
const {reconcileChildren,preserveInteraction}=require('../js/ui-regions.cjs');

test('reconciliation retains unchanged nodes, removes stale nodes and only moves reordered nodes',()=>{
 const host={children:[],moves:0,insertBefore(child,next){this.moves++;child.remove();const index=this.children.indexOf(next);this.children.splice(index<0?this.children.length:index,0,child);child.parent=this;}};
 const node=id=>({id,parent:host,remove(){const index=this.parent.children.indexOf(this);if(index>=0)this.parent.children.splice(index,1);}});
 const a=node('a'),b=node('b'),c=node('c');host.children=[a,b,c];
 reconcileChildren(host,[a,b,c]);assert.equal(host.moves,0);
 reconcileChildren(host,[c,a]);assert.deepEqual(host.children,[c,a]);assert.equal(host.moves,1);
 const d=node('d');reconcileChildren(host,[c,a,d]);assert.deepEqual(host.children,[c,a,d]);assert.equal(host.moves,2);
});

test('local replacement restores semantic focus, caret and viewport without overwriting draft values',()=>{
 const viewport={scrollTop:720};let focused,selection;
 const old={name:'',id:'',value:'未保存',selectionStart:1,selectionEnd:3,isConnected:true,getAttribute:()=> '资源类型 source-1'};
 const next={name:'',id:'',value:'新类型',getAttribute:()=> '资源类型 source-1',focus(options){focused=options;viewport.scrollTop=0;},setSelectionRange(...args){selection=args;}};
 let controls=[old];const host={ownerDocument:{activeElement:old},contains:node=>node===old,querySelectorAll:()=>controls,closest:()=>viewport};
 preserveInteraction(host,()=>{old.isConnected=false;controls=[next];viewport.scrollTop=15;});
 assert.deepEqual(focused,{preventScroll:true});assert.deepEqual(selection,[1,3]);assert.equal(viewport.scrollTop,720);assert.equal(next.value,'新类型');
});

test('unaffected focus stays on its existing node and missing controls do not steal focus',()=>{
 let refocused=0;const active={isConnected:true,getAttribute:()=> 'draft',focus(){refocused++;}};
 const host={ownerDocument:{activeElement:active},contains:()=>true,querySelectorAll:()=>[active]};
 preserveInteraction(host,()=>{});assert.equal(refocused,0);
 host.querySelectorAll=()=>[];preserveInteraction(host,()=>{active.isConnected=false;});assert.equal(refocused,0);
});
