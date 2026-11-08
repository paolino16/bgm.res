'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../js/resource-search-ui.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const best='a'.repeat(40),alt='b'.repeat(40),absent='c'.repeat(40);
const hit=level=>({level,tags:['Patch Required'],entries:[{url:'https://seadex.moe/123',notes:'Check notes'}]});

function fixture(t,{lookup,rows}){
  const previous=global.localStorage;
  const storage=new Map([['resource-sources-version','2'],['resource-sources','["nyaa"]']]);
  global.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
  t.after(()=>{global.localStorage=previous;});
  const nodes=[],lookups=[],opened=[];
  function node(tag,className='',textContent=''){
    const item={tag,className,textContent,children:[],attributes:{},isConnected:true,
      append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
      setAttribute(key,value){this.attributes[key]=value;},focus(){},querySelector(){return null;},classList:{toggle(){}}};
    nodes.push(item);return item;
  }
  const root=node('main');
  const ui=create({node,button:(text,onclick,cls)=>Object.assign(node('button',cls,text),{onclick}),
    ipc:{invoke:async(channel,args)=>{
      if(channel==='resources:settings')return {enabled:false};
      if(channel==='resources:seadex'){lookups.push(args);return lookup(args);}
      assert.equal(channel,'resources:search');
      return {rows:rows(args.query).map((row,i)=>({source:'nyaa',page:'https://nyaa.si/view/'+i,...row})),next:null};
    }},container:()=>root,setHeader(){},notice(){},shell:{openExternal:async url=>{opened.push(url);}}});
  ui.render();
  const toggle=nodes.find(n=>n.textContent==='只看 SeaDex');
  const results=nodes.find(n=>n.className==='resource-results');
  return {nodes,opened,lookups,results,toggle,storage,
    submit:async query=>{
      const input=nodes.find(n=>n.attributes['aria-label']==='资源关键词');input.value=query;input.oninput();
      nodes.find(n=>n.tag==='form').onsubmit({preventDefault(){}});await tick();
    },
    articles:()=>results.children.filter(n=>n.tag==='article'),
    filter:enabled=>{if((toggle.attributes['aria-pressed']==='true')!==enabled)toggle.onclick();}
  };
}
const badges=article=>article.children[0].children[1].children.filter(n=>n.className.startsWith('resource-seadex '));

test('SeaDex badges and filters use exact hashes independently of title highlighting',async t=>{
  let complete;
  const ui=fixture(t,{lookup:()=>new Promise(resolve=>{complete=resolve;}),rows:()=>[
    {title:'[Unknown] Best',hash:best.toUpperCase()},
    {title:'[Unknown] Alt',hash:alt},
    {title:'[VCB-Studio] unlisted',hash:absent},
    {title:'[VCB-Studio] no hash'}
  ]});
  assert.equal(ui.nodes.some(n=>n.attributes['aria-label']==='SeaDex 推荐筛选'),false);
  ui.filter(true);await ui.submit('Anime');
  assert.equal(ui.articles().length,0);
  assert.deepEqual(ui.lookups,[[best,alt,absent]]);
  complete({matches:{[best]:hit('best'),[alt]:hit('alt'),[absent]:null}});await tick();
  assert.equal(ui.articles().length,2);
  const badge=badges(ui.articles()[0])[0];assert.equal(badge.textContent,'SeaDex Best');
  assert.equal(badge.title.includes('Patch Required'),true);
  await badge.onclick();assert.deepEqual(ui.opened,['https://seadex.moe/123']);
  assert.equal(badges(ui.articles()[1])[0].textContent,'SeaDex Alt');
  ui.filter(false);assert.equal(ui.articles().length,4);
  assert.equal(badges(ui.articles()[2]).length,0);assert.equal(badges(ui.articles()[3]).length,0);
  const highlighted=ui.nodes.find(n=>n.textContent==='只看高亮');
  highlighted.onclick();
  assert.equal(ui.articles().length,2);
  assert.equal(ui.articles().every(article=>badges(article).length===0),true);
  ui.filter(true);assert.equal(ui.articles().length,2);
  assert.equal(highlighted.attributes['aria-pressed'],'false');
  assert.equal(ui.articles().every(article=>badges(article).length===1),true);
  highlighted.onclick();assert.equal(ui.toggle.attributes['aria-pressed'],'false');
  assert.equal(ui.articles().every(article=>badges(article).length===0),true);
  highlighted.onclick();assert.equal(ui.articles().length,4);
  assert.equal(highlighted.attributes['aria-pressed'],'false');
  ui.filter(true);ui.filter(false);assert.equal(ui.articles().length,4);
  ui.filter(true);
  ui.nodes.find(n=>n.textContent==='清除筛选').onclick();
  assert.equal(ui.toggle.attributes['aria-pressed'],'false');assert.equal(ui.articles().length,4);
});

test('SeaDex failure leaves search usable and retry attaches badges',async t=>{
  let calls=0;
  const ui=fixture(t,{rows:()=>[{title:'[ReinForce] Anime',hash:best}],lookup:async()=>{
    if(++calls===1)throw Error('offline');return {matches:{[best]:hit('best')}};
  }});
  await ui.submit('Anime');assert.equal(ui.articles().length,1);assert.equal(badges(ui.articles()[0]).length,0);
  const retry=ui.nodes.find(n=>n.textContent==='SeaDex 暂不可用 · 重试');assert.equal(retry.title,'offline');
  retry.onclick();await tick();assert.equal(badges(ui.articles()[0])[0].textContent,'SeaDex Best');
});

test('late SeaDex responses cannot label a newer search',async t=>{
  let complete;
  const ui=fixture(t,{rows:query=>[{title:query,hash:query==='Old'?best:alt}],lookup:hashes=>
    hashes.includes(best)?new Promise(resolve=>{complete=resolve;}):Promise.resolve({matches:{[alt]:hit('alt')}})});
  await ui.submit('Old');await ui.submit('New');
  assert.equal(badges(ui.articles()[0])[0].textContent,'SeaDex Alt');
  complete({matches:{[best]:hit('best')}});await tick();
  assert.equal(ui.articles().length,1);assert.equal(badges(ui.articles()[0])[0].textContent,'SeaDex Alt');
});
