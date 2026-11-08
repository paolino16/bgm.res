const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {regularPlaylist,associatedPlayer,play}=require('../js/episode-playlist.cjs');

function fixture(root=path.resolve('media')){
  const work={Name:'作品',DefaultSubtitleGroup:'Other',EPDetails:{},RenameBinding:{files:[]}};
  const file=(number,group='Group')=>path.join(root,`作品 EP${number} [${group}].mkv`);
  for(const number of [5,2,4,1,3]){
    const versions=['Other','Group'].map(group=>({path:file(number,group),subtitleGroup:group}));
    work.EPDetails['EP'+number]={EpisodeNumber:number,LocalIndex:number,AbsolutePath:file(number,'Other'),Versions:versions};
    work.RenameBinding.files.push(...versions);
  }
  return {work,file};
}

test('rotates the same subtitle group from the chosen version as 3,4,5,1,2',()=>{
  const {work,file}=fixture();assert.deepEqual(regularPlaylist(work,file(3)),[3,4,5,1,2].map(n=>file(n)));
  assert.deepEqual(regularPlaylist(work,file(5)),[5,1,2,3,4].map(n=>file(n)));
  assert.deepEqual(regularPlaylist(work,file(1)),[1,2,3,4,5].map(n=>file(n)));
});

test('excludes special chapters, collections, unavailable files and missing group versions',()=>{
  const {work,file}=fixture();
  work.EPDetails.SP={EpisodeType:1,EpisodeNumber:0,Versions:[{path:file('SP')}]};
  work.EPDetails.Collection={Collection:true,EpisodeNumber:0,Versions:[{path:file('collection')}]};
  work.EPDetails.EP4.Versions=work.EPDetails.EP4.Versions.filter(v=>v.subtitleGroup==='Other');
  work.RenameBinding.files.find(v=>v.path===file(2)).availability='missing';
  assert.deepEqual(regularPlaylist(work,file(3)),[3,5,1].map(n=>file(n)));
  assert.deepEqual(regularPlaylist(work,file('SP')),[file('SP')]);
  assert.deepEqual(regularPlaylist(work,file('collection')),[file('collection')]);
});

test('resolves the default video player independently of playlist file association',async()=>{
  const calls=[];
  const player=await associatedPlayer('D:/作品.mkv',{run:async(exe,args)=>{
    calls.push({exe,args});
    return {stdout:args.includes('ProgId')?'ProgId    REG_SZ    mplayerc64.mkv':'(Default)    REG_SZ    "F:\\Player With Spaces\\mpc-hc64.exe" "%1"'};
  }});
  assert.equal(player,'F:\\Player With Spaces\\mpc-hc64.exe');
  assert.match(calls[0].args[1],/\.mkv\\UserChoice$/);
  assert.match(calls[1].args[1],/mplayerc64\.mkv\\shell\\open\\command$/);
});

test('writes a Unicode playlist in requested order and launches the video default player',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-playlist-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const {work,file}=fixture(root);await Promise.all([1,2,3,4,5].map(n=>fs.writeFile(file(n),'video')));
  await fs.unlink(file(4));const calls=[];
  const result=await play({work,file:file(3),directory:root,platform:'win32',shell:{openPath:async()=>assert.fail('must use the video default player')},
    resolvePlayer:async target=>{assert.equal(target,file(3));return 'mpc-hc64.exe';},launch:async(...args)=>calls.push(args)});
  assert.deepEqual(result.files,[3,5,1,2].map(n=>file(n)));
  assert.equal(calls[0][0],'mpc-hc64.exe');
  assert.equal(calls[0][1],result.playlist);
  assert.equal(await fs.readFile(result.playlist,'utf8'),'\uFEFF#EXTM3U\r\n'+[3,5,1,2].map(n=>file(n)).join('\r\n')+'\r\n');
});

test('a single episode opens directly and empty selected files report failure',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-playlist-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'one.mkv');await fs.writeFile(file,'video');const opened=[];
  await play({work:{},file,directory:root,shell:{openPath:async file=>{opened.push(file);return '';}}});
  assert.deepEqual(opened,[file]);await fs.writeFile(file,'');
  await assert.rejects(play({work:{},file,directory:root,shell:{}}),/为空文件/);
});
