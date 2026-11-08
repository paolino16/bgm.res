const {test}=require('node:test');
const assert=require('node:assert/strict');
const {proxyURL,metadataProxies}=require('../js/metadata-proxy.cjs');
test('PAC proxy is selected before DIRECT and direct-first stays direct',()=>{
  assert.equal(proxyURL('PROXY 127.0.0.1:7890; SOCKS5 127.0.0.1:7890; DIRECT;'),'http://127.0.0.1:7890');
  assert.equal(proxyURL('DIRECT; PROXY 127.0.0.1:7890'),null);
  assert.equal(proxyURL('HTTPS [::1]:7890'),'https://[::1]:7890');
});
test('desktop resolves each metadata host independently and tolerates unavailable PAC',async()=>{
  const routes=await metadataProxies(async url=>{
    if(url.includes('api.bgm.tv'))return 'PROXY 127.0.0.1:7890; DIRECT';
    if(url.includes('api.jikan.moe'))throw Error('unavailable');
    return 'DIRECT';
  });
  assert.deepEqual(routes,{'api.bgm.tv':'http://127.0.0.1:7890'});
});
