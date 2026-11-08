'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {titleParts,highlightTitle,createMatcher,normalizeKeywords,defaultKeywords,loadKeywords}=require('../js/resource-keywords.cjs');

test('release keywords support aliases, separator variants and multiple groups',()=>{
  const title='[喵萌&vcb_studio] Title [LittleBakas!] [jsum@U2] [Snow-Raws]';
  const parts=titleParts(title);
  assert.equal(parts.map(part=>part.text).join(''),title);
  assert.deepEqual(parts.filter(part=>part.highlight).map(part=>part.text),
    ['vcb_studio','LittleBakas!','jsum','Snow-Raws']);
  assert.deepEqual(titleParts('[VCB-S]')[1],{text:'VCB-S',highlight:true});
});

test('common or disputed release names are not reputation highlights',()=>{
  assert.equal(titleParts('[ReinForce]').some(part=>part.highlight),true);
  const title='[Ohys-Raws] [Ohy-Raws] [UCCUSS] [IrizaRaws] '+
    '[Moozzi2] [ANK-Raws] [AI-Raws] [LowPower-Raws] [DewDream] [MTBB]';
  assert.equal(titleParts(title).some(part=>part.highlight),false);
});

test('custom keywords are deduplicated literal text, separate from the built-in list',()=>{
  const keywords=normalizeKeywords('My.Group\n my.group，C++ ; 1080p\n');
  assert.deepEqual(keywords,['My.Group','C++','1080p']);
  const match=createMatcher([...keywords,'ReinForce']);
  assert.deepEqual(match('[my.group] C++ 1080p [ReinForce]').filter(p=>p.highlight).map(p=>p.text),
    ['my.group','C++','1080p','ReinForce']);
  assert.equal(match('MyXGroup').some(p=>p.highlight),false);
  assert.equal(createMatcher([])('[my.group]').some(p=>p.highlight),false);
  assert.deepEqual(normalizeKeywords({bad:true}),[]);
});

test('the complete highlight list can remove defaults, stay empty, migrate and restore',()=>{
  const storage=new Map([['resource-custom-keywords','["Custom"]']]);
  const read=()=>loadKeywords({getItem:key=>storage.get(key)??null});
  assert.equal(read().includes('VCB-Studio'),true);
  assert.equal(read().includes('Custom'),true);
  storage.set('resource-highlight-keywords','["Custom"]');
  assert.deepEqual(read(),['Custom']);
  assert.equal(createMatcher(read())('[VCB-Studio]').some(p=>p.highlight),false);
  storage.set('resource-highlight-keywords','[]');
  assert.deepEqual(read(),[]);
  assert.equal(createMatcher(read())('Anything').some(p=>p.highlight),false);
  storage.set('resource-highlight-keywords',JSON.stringify(defaultKeywords()));
  assert.equal(read().includes('ReinForce'),true);
});

test('ordinary words and HTML stay literal, with no substring or stateful matches',()=>{
  const plain='Akane home sam xjsum VCBStudio THORAX';
  assert.equal(titleParts(plain).some(part=>part.highlight),false);
  const title='<img src=x onerror=alert(1)> [jsum]';
  const node=(tag,className,textContent)=>({tag,className,textContent});
  let children;
  highlightTitle({replaceChildren(...items){children=items;}},title,node);
  assert.equal(children.map(child=>child.textContent).join(''),title);
  assert.equal(children[0].tag,'span');
  assert.equal(children[1].tag,'mark');
  assert.deepEqual(titleParts(title),titleParts(title));
});
