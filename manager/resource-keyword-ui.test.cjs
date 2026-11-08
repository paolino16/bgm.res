'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../js/resource-search-ui.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('custom keywords persist and filters cover fetched pages without crawling sources',async t=>{
  const previous=global.localStorage;
  const storage=new Map([['resource-sources-version','2'],['resource-sources','["nyaa"]'],
    ['resource-highlight-keywords','["ReinForce","My.Group"]']]);
  global.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
  t.after(()=>{global.localStorage=previous;});
  const nodes=[],calls=[];
  function node(tag,className='',textContent=''){
    const item={tag,className,textContent,children:[],attributes:{},isConnected:true,
      append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
      setAttribute(key,value){this.attributes[key]=value;},focus(){},querySelector(){return null;},classList:{toggle(){}}};
    nodes.push(item);return item;
  }
  const row=index=>({title:index===55?'[ReinForce] Anime':index===60?'[My.Group] Anime':'Other '+index,
    page:'https://nyaa.si/view/'+index,hash:String(index),source:'nyaa'});
  function fixture(){
    const root=node('main');
    const ui=create({node,button:(text,onclick,cls)=>Object.assign(node('button',cls,text),{onclick}),
      ipc:{invoke:async(channel,args)=>{
        if(channel==='resources:settings')return {enabled:false};
        assert.equal(channel,'resources:search');calls.push(args.cursor);
        return args.cursor?{rows:Array.from({length:5},(_,i)=>row(60+i)),next:null}:
          {rows:Array.from({length:60},(_,i)=>row(i)),next:1};
      }},container:()=>root,setHeader(){},notice(){},shell:{}});
    ui.render();return root;
  }
  const root=fixture();
  assert.equal(nodes.some(n=>n.attributes['aria-label']==='筛选已获取的结果'),false);
  const only=nodes.find(n=>n.textContent==='只看高亮');only.onclick();
  const query=nodes.find(n=>n.attributes['aria-label']==='资源关键词');query.value='Anime';query.oninput();
  nodes.find(n=>n.tag==='form').onsubmit({preventDefault(){}});await tick();
  const results=nodes.find(n=>n.className==='resource-results');
  const articles=()=>results.children.filter(n=>n.tag==='article');
  const text=n=>n.children.length?n.children.map(text).join(''):n.textContent;
  assert.deepEqual(calls,[null]);
  assert.equal(articles().length,1); // Searches all 60 fetched rows, not just page one.
  assert.equal(text(articles()[0].children[0].children[0]),'[ReinForce] Anime');
  const load=results.children.find(n=>n.textContent==='加载更多结果继续筛选');
  await load.onclick();await tick();
  assert.deepEqual(calls,[null,1]);assert.equal(articles().length,2);
  const custom=nodes.find(n=>n.tag==='textarea');custom.value='My.Group\nmy.group';
  nodes.find(n=>n.textContent==='保存名单').onclick();
  assert.deepEqual(JSON.parse(storage.get('resource-highlight-keywords')),['My.Group']);
  assert.equal(articles().length,1);
  assert.equal(articles()[0].children[0].children[0].children.some(n=>n.tag==='mark'&&n.textContent==='My.Group'),true);
  custom.value='no matches';nodes.find(n=>n.textContent==='保存名单').onclick();assert.equal(articles().length,0);
  custom.value='My.Group';nodes.find(n=>n.textContent==='保存名单').onclick();
  nodes.find(n=>n.textContent==='清除筛选').onclick();
  assert.equal(articles().length,50);assert.equal(only.attributes['aria-pressed'],'false');
  assert.equal(root.children.length,1);
  fixture();assert.equal(nodes.filter(n=>n.tag==='textarea').at(-1).value,'My.Group');
  custom.value='';nodes.find(n=>n.textContent==='保存名单').onclick();
  assert.deepEqual(JSON.parse(storage.get('resource-highlight-keywords')),[]);
  nodes.find(n=>n.textContent==='恢复默认名单').onclick();
  assert.equal(JSON.parse(storage.get('resource-highlight-keywords')).includes('ReinForce'),true);
});
