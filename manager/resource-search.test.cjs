'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {EventEmitter} = require('node:events');
const {create, groups} = require('../js/resource-search-ui.cjs');
const {ExtSession} = require('../js/resource-search-main.cjs');

const title = '[SweetSub&绿茶字幕组&LoliHouse] 缎带英雄 / The Ribbon Hero [v2][WebRip 1080p HEVC-10bit AAC EAC3][简繁日内封字幕]';
const hash = '104605e724d68d7badad2fdd0d0185778ca93fac';
const ext = {source:'ext', title, page:'https://ext.to/release-21457488/', hash:'', size:'3.2 GB'};
const nyaa = {source:'nyaa', title, page:'https://nyaa.si/view/2149233', hash, size:'3.2 GiB'};

function mikanCacheFixture() {
  const filename=path.resolve(__dirname,'../js/resource-search-main.cjs');
  const nativeRequire=createRequire(filename), module={exports:{}};
  const calls=[];
  let now=0, fail=false;
  function spawn() {
    const child=new EventEmitter();
    child.stdout=new EventEmitter();
    child.stderr=new EventEmitter();
    child.stdin=new EventEmitter();
    child.stdin.end=payload=>{
      const args=JSON.parse(payload);
      calls.push(args);
      const error=fail;
      fail=false;
      const rows=Array.from({length:245},(_,index)=>({title:args.query+' '+index,page:String(index)}));
      const value=args.action==='mikan-web'?{rows,next:null}:{rows:rows.slice(0,100),next:1};
      queueMicrotask(()=>{
        child.stdout.emit('data',Buffer.from(JSON.stringify(error?{error:'temporary failure'}:{value})));
        child.emit('close',0);
      });
    };
    return child;
  }
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,console,setTimeout,Buffer,
    Date:{now:()=>now},require:name=>{
      if(name==='electron')return {dialog:{},clipboard:{}};
      if(name==='node:child_process')return {...nativeRequire(name),spawn};
      return nativeRequire(name);
    }});
  const handlers=new Map();
  module.exports.register({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
    app:{getPath:()=>__dirname,once(){}},sysdata:{get:(key,fallback)=>fallback}});
  return {calls,expire:()=>{now+=180001;},fail:()=>{fail=true;},
    search:(cursor,query='高达')=>handlers.get('resources:search')(null,{source:'mikan',query,cursor})};
}

test('Mikan web pagination shares a cached result set across pages and concurrent requests', async () => {
  const fixture=mikanCacheFixture();
  assert.equal((await fixture.search(null)).rows.length,100);
  const [first,second]=await Promise.all([fixture.search(1),fixture.search(2)]);
  assert.equal(first.rows.length,100);
  assert.equal(second.rows[0].title,'高达 100');
  assert.equal(fixture.calls.length,2);
  assert.equal(fixture.calls[1].action,'mikan-web');
  const third=await fixture.search(3);
  assert.equal(third.rows.length,45);
  assert.equal(third.next,null);
  assert.equal(fixture.calls.length,2);
  await fixture.search(1,'缎带英雄');
  assert.equal(fixture.calls.length,3);
  fixture.expire();
  await fixture.search(2);
  assert.equal(fixture.calls.length,4);
});

test('a failed Mikan web fetch can be retried', async () => {
  const fixture=mikanCacheFixture();
  fixture.fail();
  await assert.rejects(fixture.search(1),/temporary failure/);
  assert.equal((await fixture.search(1)).rows.length,100);
  assert.equal(fixture.calls.length,2);
});

test('only confirmed hashes merge and unresolved EXT stays separate', () => {
  const row = {...ext};
  assert.equal(groups([nyaa,row]).length, 2);
  assert.equal(groups([nyaa,{...row,hash:'a'.repeat(40)}]).length, 2);
  const knaben = {...nyaa,source:'knaben',page:'https://knaben.org/search/index.php?q=Release'};
  const combined = groups([nyaa,knaben,row]);
  assert.equal(combined.length, 2);
  assert.deepEqual(combined.find(group=>group.length===2).map(row=>row.source), ['nyaa','knaben']);
  assert.equal(row.hash, '');
});

test('EXT resolution shares in-flight work and caches successful hashes', async () => {
  const session = new ExtSession();
  let calls = 0, complete;
  session.run = async args => {
    calls++;
    assert.equal(args.action, 'resolve');
    assert.equal(args.row.page, ext.page);
    return new Promise(resolve => {complete = resolve;});
  };
  const first = session.resolve(ext);
  const second = session.resolve(ext);
  complete({hash, magnet:'magnet:?xt=urn:btih:'+hash});
  assert.deepEqual(await first, await second);
  assert.equal((await session.resolve(ext)).hash, hash);
  assert.equal(calls, 1);
});

test('EXT resolution failures can be retried', async () => {
  const session = new ExtSession();
  let calls = 0;
  session.run = async () => {
    if (++calls === 1) throw Error('temporary failure');
    return {hash, magnet:'magnet:?xt=urn:btih:'+hash};
  };
  await assert.rejects(session.resolve(ext), /temporary failure/);
  assert.equal((await session.resolve(ext)).hash, hash);
  assert.equal(calls, 2);
});

test('copy reuses the resolved EXT magnet and respects disabled sources', async () => {
  const filename=path.resolve(__dirname,'../js/resource-search-main.cjs');
  const nativeRequire=createRequire(filename);
  const module={exports:{}};
  let copies=0, calls=0, enabled=true;
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,console,setTimeout,
    require:name=>name==='electron'?{dialog:{},clipboard:{writeText(){copies++;}}}:nativeRequire(name)});
  const {register,ExtSession:Session}=module.exports;
  Session.prototype.start=async()=>1234;
  Session.prototype.run=async()=>{calls++;return {hash,magnet:'magnet:?xt=urn:btih:'+hash};};
  const handlers=new Map();
  register({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
    app:{getPath:()=>__dirname,once(){}},sysdata:{get:()=>enabled,set(){}}});
  const copy=()=>handlers.get('resources:action')(null,{row:ext,action:'copy'});
  await copy();
  await copy();
  assert.equal(copies,2);
  assert.equal(calls,1);
  enabled=false;
  await assert.rejects(copy(),/启用 EXT/);
});

test('search defaults, legacy selections, and explicit selections use the right sources', async t => {
  const scenarios = [
    {name:'fresh defaults', saved:null, version:null, enabled:false, expected:['dmhy','mikan','anibt','nyaa','knaben'], articles:1},
    {name:'legacy migration', saved:['nyaa','ext'], version:null, enabled:true, expected:['nyaa','knaben'], articles:1},
    {name:'explicit EXT selection', saved:['nyaa','ext'], version:'2', enabled:true, expected:['nyaa','ext'], articles:2},
    {name:'explicit Knaben deselection', saved:['nyaa'], version:'2', enabled:false, expected:['nyaa'], articles:1}
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const previous = global.localStorage;
    const storage = new Map();
    if(scenario.saved)storage.set('resource-sources',JSON.stringify(scenario.saved));
    if(scenario.version)storage.set('resource-sources-version',scenario.version);
    global.localStorage = {getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
    t.after(()=>{global.localStorage=previous;});
    const nodes = [];
    function node(tag, className='', textContent='') {
      const value = {tag,className,textContent,children:[],isConnected:true,
        append(...children){this.children.push(...children);},
        replaceChildren(...children){this.children=children;},
        setAttribute(){}, focus(){}, querySelector(){return null;}, classList:{toggle(){}}};
      nodes.push(value);
      return value;
    }
    const root=node('main'), searched=[];
    let copied;
    const ipc = {invoke:async(channel,args)=>{
      if(channel==='resources:settings')return {enabled:scenario.enabled};
      if(channel==='resources:search'){
        searched.push(args.source);
        const rows={nyaa,ext,knaben:{...nyaa,source:'knaben',page:'https://knaben.org/search/index.php?q=Release'}};
        return {rows:rows[args.source]?[{...rows[args.source]}]:[],next:null};
      }
      assert.equal(channel,'resources:action');
      copied=args.row;
      return {hash,magnet:'magnet:?xt=urn:btih:'+hash};
    }};
    const ui=create({ipc,node,button:(text,onclick,className)=>{
      const control=node('button',className,text);
      control.onclick=onclick;
      return control;
    },shell:{},notice(){},setHeader(){},container:()=>root});
    ui.render();
    await new Promise(resolve=>setImmediate(resolve));
    const input=nodes.find(value=>value.tag==='input');
    input.value='The Ribbon Hero';
    input.oninput();
    nodes.find(value=>value.tag==='form').onsubmit({preventDefault(){}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(searched,scenario.expected);
    const results=nodes.find(value=>value.className==='resource-results');
    const articles=results.children.filter(value=>value.tag==='article');
    assert.equal(articles.length,scenario.articles);
    const links=articles.flatMap(article=>article.children[0].children[1].children).filter(value=>value.className==='resource-source');
    assert.equal(links.some(link=>link.textContent==='Knaben'),scenario.expected.includes('knaben'));
    assert.equal(storage.get('resource-sources-version'),'2');
    await articles[0].children[1].children[1].onclick();
    assert.equal(copied.source,'nyaa');
  });
});

test('EXT is disabled by default and does not warm a browser', () => {
  const filename=path.resolve(__dirname,'../js/resource-search-main.cjs');
  const nativeRequire=createRequire(filename), module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,console,setTimeout,
    require:name=>name==='electron'?{dialog:{},clipboard:{}}:nativeRequire(name)});
  const {register,ExtSession:Session}=module.exports;
  let starts=0;
  Session.prototype.start=async()=>{starts++;};
  const handlers=new Map();
  register({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
    app:{getPath:()=>__dirname,once(){}},sysdata:{get:(key,fallback)=>fallback}});
  assert.equal(handlers.get('resources:settings')().enabled,false);
  assert.equal(starts,0);
});

test('prefetch preserves published pages while newer releases arrive', async t => {
  const previous=global.localStorage;
  global.localStorage={getItem:key=>key==='resource-sources-version'?'2':JSON.stringify(['knaben'])};
  t.after(()=>{global.localStorage=previous;});
  const nodes=[];
  function node(tag,className='',textContent='') {
    const item={tag,className,textContent,children:[],isConnected:true,
      append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
      setAttribute(){},setCustomValidity(){},reportValidity(){return true;},focus(){},querySelector(){return null;},classList:{toggle(){}}};
    nodes.push(item);
    return item;
  }
  const root=node('main');
  const calls=[];
  let complete;
  const ipc={invoke:async(channel,args)=>{
    if(channel==='resources:settings')return {enabled:false};
    assert.equal(channel,'resources:search');
    calls.push(args.cursor);
    if(args.query==='新搜索')return {rows:[{...nyaa,source:'knaben',title:'New result',page:'https://knaben.org/search/index.php?q=new'}],next:null};
    const start=args.cursor?120:0, count=args.cursor?60:120;
    const batch={rows:Array.from({length:count},(_,index)=>({source:'knaben',title:'Release '+(start+index),
      hash:String(start+index),page:'https://knaben.org/search/index.php?q='+(start+index),
      date:args.cursor?'2099-01-01':'2026-01-01'})),next:args.cursor?null:1};
    if(args.cursor)return new Promise(resolve=>{complete=()=>resolve(batch);});
    return batch;
  }};
  const ui=create({ipc,node,button:(text,onclick,className)=>{
    const item=node('button',className,text);item.onclick=onclick;return item;
  },shell:{},notice(){},setHeader(){},container:()=>root});
  ui.render();
  const input=nodes.find(item=>item.tag==='input');
  input.value='高达';input.oninput();
  nodes.find(item=>item.tag==='form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  const results=nodes.find(item=>item.className==='resource-results');
  const titles=()=>results.children.filter(item=>item.tag==='article').map(item=>item.children[0].children[0].textContent);
  async function click(label) {
    const nav=results.children.find(item=>item.className==='resource-pagination');
    const control=nav.children.find(item=>item.textContent===label);
    assert.equal(control.disabled,false);
    await control.onclick();
  }
  async function jump(page){
    const nav=results.children.find(item=>item.className==='resource-pagination');
    const form=nav.children.find(item=>item.tag==='form');
    const field=form.children.find(item=>item.tag==='label').children.find(item=>item.tag==='input');
    field.value=String(page);
    await form.onsubmit({preventDefault(){}});
  }
  assert.equal(titles().length,50);
  await click('下一页');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(titles()[0],'Release 50');
  assert.equal(calls.length,2);
  const status=nodes.find(item=>item.className==='resource-status');
  assert.equal(status.children.some(item=>item.textContent.includes('搜索中')),false);
  assert.equal(status.children.some(item=>item.textContent==='后台预取中…'),true);
  await click('下一页');
  assert.equal(titles().length,20);
  const thirdPage=titles();
  await click('上一页');
  assert.equal(titles()[0],'Release 50');
  await click('下一页');
  assert.deepEqual(titles(),thirdPage);
  assert.equal(calls.length,2);
  const pendingNext=click('下一页');
  assert.equal(calls.length,2);
  complete();
  await pendingNext;
  assert.equal(titles()[0],'Release 120');
  assert.equal(titles().length,50);
  assert.equal(calls.length,2);
  await click('上一页');
  assert.deepEqual(titles(),thirdPage);
  await jump(5);
  assert.equal(titles()[0],'Release 170');
  assert.equal(titles().length,10);
  assert.equal(calls.length,2);
  await jump(3);
  await click('上一页');
  await click('上一页');
  assert.equal(titles()[0],'Release 0');
  assert.equal(calls.length,2);
  nodes.find(item=>item.tag==='form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  await click('下一页');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,4);
  complete();
  await new Promise(resolve=>setImmediate(resolve));
  await click('下一页');
  assert.equal(titles()[0],'Release 120');
  await click('上一页');
  assert.equal(titles()[0],'Release 50');
  await click('下一页');
  await click('下一页');
  assert.equal(titles()[0],'Release 170');
  assert.equal(titles()[10],'Release 100');
  nodes.find(item=>item.tag==='form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  await click('下一页');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,6);
  const obsolete=complete;
  input.value='新搜索';input.oninput();
  nodes.find(item=>item.tag==='form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  obsolete();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(titles(),['New result']);
  assert.equal(calls.length,7);
  input.value='高达';input.oninput();
  nodes.find(item=>item.tag==='form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  await jump(4);
  assert.equal(calls.length,8);
  assert.equal(titles()[0],'Release 0');
  await jump(3);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,9);
  complete();await new Promise(resolve=>setImmediate(resolve));
  await jump(5);
  assert.equal(titles()[0],'Release 170');
  assert.equal(titles().length,10);
  await jump(1);
  assert.equal(titles()[0],'Release 0');
});

test('publication time determines later pages regardless of source batch sizes', async t => {
  const previous=global.localStorage;
  global.localStorage={getItem:key=>key==='resource-sources-version'?'2':JSON.stringify(['mikan','nyaa'])};
  t.after(()=>{global.localStorage=previous;});
  const nodes=[];
  function node(tag,className='',textContent='') {
    const item={tag,className,textContent,children:[],isConnected:true,
      append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
      setAttribute(){},focus(){},querySelector(){return null;},classList:{toggle(){}}};
    nodes.push(item);return item;
  }
  const root=node('main'),calls=[];
  const ipc={invoke:async(channel,args)=>{
    if(channel==='resources:settings')return {enabled:false};
    assert.equal(channel,'resources:search');
    calls.push([args.source,args.cursor]);
    const source=args.source, count=source==='mikan'?200:50;
    const start=args.cursor?count:0;
    const host=source==='mikan'?'mikan.sakuramoe.dev':'nyaa.si';
    return {rows:Array.from({length:count},(_,index)=>({source,title:source+' '+(start+index),
      hash:source+'-'+(start+index),page:'https://'+host+'/release/'+(start+index),
      date:args.cursor?'2099-01-01':source==='mikan'?'2026-01-01':'2025-01-01'})),
      next:args.cursor?null:1};
  }};
  const ui=create({ipc,node,button:(text,onclick,className)=>{
    const item=node('button',className,text);item.onclick=onclick;return item;
  },shell:{},notice(){},setHeader(){},container:()=>root});
  ui.render();
  const input=nodes.find(item=>item.tag==='input');input.value='高达';input.oninput();
  nodes.find(item=>item.tag==='form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  const results=nodes.find(item=>item.className==='resource-results');
  const titles=()=>results.children.filter(item=>item.tag==='article').map(item=>item.children[0].children[0].textContent);
  async function click(label) {
    const control=results.children.find(item=>item.className==='resource-pagination').children.find(item=>item.textContent===label);
    assert.equal(control.disabled,false);await control.onclick();
    await new Promise(resolve=>setImmediate(resolve));
  }
  await click('下一页');
  const secondPage=titles();
  assert.equal(secondPage.filter(title=>title.startsWith('mikan')).length,50);
  assert.equal(secondPage.filter(title=>title.startsWith('nyaa')).length,0);
  await click('下一页');
  assert.deepEqual(calls,[['mikan',null],['nyaa',null]]);
  await click('上一页');
  assert.deepEqual(titles(),secondPage);
});
