'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {metadata}=require('../js/subtitle-attachment-meta.cjs');
test('attachment metadata is independent of Discuz layout and ordering',()=>{
  const name='物語系列.Monogatari 合集.260204.7z';
  const expected={summary:'4.32 MB · 下载 373 次',uploaded:'2026-02-04 01:14',note:''};
  for(const note of [name+' 2026-2-4 01:14 上传 4.32 MB, 下载次数: 373',name+' (4.32 MB, 下载次数: 373) 2026-02-04 01:14:05 上传 点击文件名下载附件',name+' （4.32 mb，下载次数：373） 2026/2/4 1:14 上传'])assert.deepEqual(metadata({name,note}),expected);
});
test('missing metadata stays absent and genuine attachment notes survive',()=>{
  assert.deepEqual(metadata({name:'show.rar',note:'show.rar 简繁双语，适配 BDMV'}),{summary:'',uploaded:'',note:'简繁双语，适配 BDMV'});
  assert.deepEqual(metadata({name:'show.rar',note:'show.rar (66.25 KB, 下载次数: 0)'}),{summary:'66.25 KB · 下载 0 次',uploaded:'',note:''});
  assert.equal(metadata({name:'2026-2-4 01:14 上传.rar',note:'2026-2-4 01:14 上传.rar 1 MiB, 下载次数: 1,234'}).summary,'1 MiB · 下载 1234 次');
});
