'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {mount}=require('../js/subtitle-inbox-ui.cjs');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(work,items){
  function node(tag,className='',textContent=''){return {tag,className,textContent,children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(name,value){this[name]=value;}};}
  const host=node('main'),calls=[],selected=[],notices=[];
  mount({node,host,work,button:(text,onclick)=>({...node('button','',text),onclick}),notice:message=>notices.push(message),
    ipc:{async invoke(channel,body){calls.push({channel,body});return channel==='subtitle-inbox:list'?items:{};}},onSelect:async(files,id)=>selected.push({files,id})});
  const all=root=>[root,...root.children.flatMap(all)];
  return {host,calls,selected,notices,all,button:text=>all(host).find(item=>item.tag==='button'&&item.textContent===text)};
}
const remaining=['D:/inbox/EP14.ass','D:/inbox/EP15.ass'];
const pack={id:'package',name:'两部分合集.zip',workId:'first',workName:'上半部',state:'pending',done:13,files:Array.from({length:25},()=>({})),remaining};
test('a partially imported package stays visible on another work and continues into that work',async()=>{
  const f=fixture({id:'second',Name:'下半部'},[pack]);await settle();
  assert.ok(f.all(f.host).some(item=>item.textContent===pack.name));
  assert.ok(f.all(f.host).some(item=>item.textContent==='已导入 13 / 25 · 剩余 2'));
  const next=f.button('继续导入');assert.match(next.title,/当前作品：下半部/);await next.onclick();
  assert.deepEqual(f.selected,[{files:remaining,id:'second'}]);
  assert.deepEqual(f.calls.find(call=>call.channel==='subtitle-inbox:command').body,{id:'package',command:'assign',workId:'second',workName:'下半部'});
  assert.deepEqual(f.notices,[]);
});
test('returning to the previous work still exposes the same remaining package',async()=>{
  const f=fixture({id:'first',Name:'上半部'},[{...pack,workId:'second',workName:'下半部'}]);await settle();await f.button('继续导入').onclick();assert.equal(f.selected[0].id,'first');
});
test('cleaned packages remain hidden on every work',async()=>{
  const f=fixture({id:'second',Name:'下半部'},[{...pack,state:'cleaned'}]);await settle();assert.equal(f.button('继续导入'),undefined);assert.ok(f.all(f.host).some(item=>item.textContent==='收件箱为空'));
});
