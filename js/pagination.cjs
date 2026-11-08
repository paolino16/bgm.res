'use strict';

function pagination({node,button,page,pages,onChange,hasMore=false,busy=false,nextDisabled=false,
  className='pagination',label='分页',summary='',draft={},contextKey=''}){
  if(draft.page!==page||draft.contextKey!==contextKey){
    draft.page=page;draft.contextKey=contextKey;draft.value=String(page);
  }
  const nav=node('nav',className);
  nav.setAttribute('aria-label',label);
  const previous=button('上一页',()=>onChange(page-1),'button quiet small');
  previous.disabled=busy||page===1;
  const numbers=node('div','pagination-pages');
  const choices=[...new Set([1,page-1,page,page+1,pages])].filter(value=>value>=1&&value<=pages).sort((a,b)=>a-b);
  let last=0;
  for(const value of choices){
    if(last&&value>last+1){
      const gap=node('span','pagination-gap','…');gap.setAttribute('aria-hidden','true');numbers.append(gap);
    }
    const control=button(String(value),()=>onChange(value),'button quiet small');
    control.setAttribute('aria-label',`第 ${value} 页`);
    if(value===page)control.setAttribute('aria-current','page');
    control.disabled=busy||value===page;
    numbers.append(control);last=value;
  }
  const position=node('span','pagination-position',`${summary?summary+' · ':''}第 ${page} 页 / ${pages}${hasMore?'+':''}`);
  position.setAttribute('role','status');
  const next=button('下一页',()=>onChange(page+1),'button quiet small');
  next.disabled=busy||nextDisabled||(page>=pages&&!hasMore);
  const form=node('form','pagination-jump');
  const field=node('label','pagination-jump-label','跳至');
  const input=node('input');
  input.type='number';input.min='1';input.step='1';input.inputMode='numeric';input.value=draft.value;input.disabled=busy;
  input.max=String(pages);
  input.setAttribute('aria-label','跳转页码');
  input.oninput=()=>{draft.value=input.value;input.setCustomValidity('');};
  field.append(input,node('span','','页'));
  const jump=button('跳转',null,'button quiet small');jump.type='submit';jump.disabled=busy;
  form.onsubmit=event=>{
    event.preventDefault();
    if(busy)return;
    const target=Number(input.value);
    if(!Number.isSafeInteger(target)||target<1||target>pages){
      input.setCustomValidity(`请输入 1 到 ${pages} 之间的整数页码`);
      input.reportValidity();return;
    }
    input.setCustomValidity('');
    return onChange(target);
  };
  form.append(field,jump);nav.append(previous,numbers,position,next,form);
  return nav;
}

module.exports={pagination};
