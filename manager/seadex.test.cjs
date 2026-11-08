'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SeaDexClient,rowHash,normalizeHash}=require('../js/seadex.cjs');
const best='a'.repeat(40),alt='b'.repeat(40),absent='c'.repeat(40);
const record=(hash,isBest)=>({infoHash:hash,isBest,tags:['Patch Required'],
  expand:{entries_via_trs:[{alID:123,notes:'Use patched release'}]}});

test('SeaDex uses exact hashes, ignores unrelated or redacted rows, caches and expires misses',async()=>{
  let now=0,calls=0;
  const client=new SeaDexClient({now:()=>now,ttl:100,fetchJSON:async address=>{
    calls++;
    const url=new URL(address);
    assert.equal(url.origin,'https://seadex.moe');
    assert.equal(url.searchParams.get('filter').includes('infoHash="'+best+'"'),true);
    return {totalPages:1,items:[record(best,true),record(alt,false),record('<redacted>',true),record('d'.repeat(40),true)]};
  }});
  const value=await client.lookup([best.toUpperCase(),alt,absent,'[VCB-Studio]']);
  assert.deepEqual(Object.keys(value.matches),[best,alt,absent]);
  assert.equal(value.matches[best].level,'best');assert.equal(value.matches[alt].level,'alt');
  assert.equal(value.matches[absent],null);
  assert.equal(value.matches[best].entries[0].url,'https://seadex.moe/123');
  await client.lookup([best,absent]);assert.equal(calls,1);
  now=101;await client.lookup([best,absent]);assert.equal(calls,2);
});

test('concurrent SeaDex lookups share requests and failed requests can retry',async()=>{
  let calls=0,complete;
  const client=new SeaDexClient({fetchJSON:()=>{calls++;return new Promise(resolve=>{complete=resolve;});}});
  const a=client.lookup([best]),b=client.lookup([best]);
  await Promise.resolve();assert.equal(calls,1);
  complete({totalPages:1,items:[record(best,true)]});
  assert.deepEqual(await a,await b);
  const broken=new SeaDexClient({fetchJSON:async()=>{throw Error('offline');}});
  await assert.rejects(broken.lookup([best]),/offline/);
  assert.equal(broken.cache.size,0);
  broken.fetchJSON=async()=>({totalPages:0,items:[]});
  assert.equal((await broken.lookup([best])).matches[best],null);
});

test('SeaDex pages fully and does not cache a partial or malformed response',async()=>{
  let calls=0;
  const client=new SeaDexClient({fetchJSON:async()=>++calls===1?{totalPages:2,items:[record(best,false)]}:{totalPages:2,items:[record(best,true)]}});
  assert.equal((await client.lookup([best])).matches[best].level,'best');assert.equal(calls,2);
  const broken=new SeaDexClient({fetchJSON:async()=>({items:[]})});
  await assert.rejects(broken.lookup([best]),/格式/);assert.equal(broken.cache.size,0);
  await assert.rejects(broken.lookup('invalid'),/哈希列表/);
});

test('row hashes are normalized from verified hash or magnet, never group or title',()=>{
  assert.equal(normalizeHash(best.toUpperCase()),best);
  assert.equal(rowHash({hash:'invalid',magnet:'magnet:?xt=urn:btih:'+alt}),alt);
  assert.equal(rowHash({title:'[VCB-Studio] '+best}), '');
  assert.equal(rowHash({hash:'<redacted>'}), '');
});
