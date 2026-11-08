'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pagination}=require('../js/pagination.cjs');

function fixture(options={}){
  const changes=[],nodes=[];
  function node(tag,className='',textContent=''){
    const item={tag,className,textContent,children:[],attributes:{},validity:'',
      append(...items){this.children.push(...items);},
      setAttribute(name,value){this.attributes[name]=value;},
      setCustomValidity(value){this.validity=value;},reportValidity(){return !this.validity;}};
    nodes.push(item);return item;
  }
  const nav=pagination({node,button:(text,onclick,className)=>{
    const item=node('button',className,text);item.onclick=onclick;return item;
  },page:5,pages:20,onChange:page=>changes.push(page),...options});
  return {nav,nodes,changes,input:nodes.find(item=>item.tag==='input'),
    submit:()=>nodes.find(item=>item.tag==='form').onsubmit({preventDefault(){}})};
}

test('pagination provides nearby page numbers, first and last pages, and direct jumps',()=>{
  const f=fixture();
  const buttons=f.nodes.filter(item=>item.attributes['aria-label']?.startsWith('第 '));
  assert.deepEqual(buttons.map(item=>item.textContent),['1','4','5','6','20']);
  assert.equal(buttons.find(item=>item.textContent==='5').attributes['aria-current'],'page');
  buttons.find(item=>item.textContent==='20').onclick();
  f.input.value='12';f.submit();
  assert.deepEqual(f.changes,[20,12]);
});

test('jump validation rejects fractional and out-of-range page numbers',()=>{
  const f=fixture();
  for(const value of ['', '0', '-1', '1.5', '21']){
    f.input.value=value;f.submit();assert.notEqual(f.input.validity,'');
  }
  assert.deepEqual(f.changes,[]);
  f.input.oninput();assert.equal(f.input.validity,'');
});

test('remote pagination only allows jumps to loaded pages while next can load more',()=>{
  const f=fixture({page:1,pages:2,hasMore:true});
  f.input.value='8';f.submit();assert.deepEqual(f.changes,[]);
  assert.equal(f.input.max,'2');
  f.input.value='2';f.submit();assert.deepEqual(f.changes,[2]);
  assert.equal(f.nodes.find(item=>item.textContent==='上一页').disabled,true);
  assert.equal(f.nodes.find(item=>item.textContent==='下一页').disabled,false);
});

test('busy pagination disables navigation and jump submission',()=>{
  const f=fixture({busy:true});
  assert.equal(f.input.disabled,true);
  assert.equal(f.nodes.filter(item=>item.tag==='button').every(item=>item.disabled),true);
});

test('background redraws retain a jump draft and page or query changes reset it',()=>{
  const draft={};
  const first=fixture({draft});first.input.value='12';first.input.oninput();
  assert.equal(fixture({draft,pages:21}).input.value,'12');
  assert.equal(fixture({draft,page:6}).input.value,'6');
  const next=fixture({draft,page:6});next.input.value='10';next.input.oninput();
  assert.equal(fixture({draft,page:6,contextKey:'new search'}).input.value,'6');
});
