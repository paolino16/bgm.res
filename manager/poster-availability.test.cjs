const {test}=require('node:test'),assert=require('node:assert/strict');
const {hasMissingRegular}=require('../js/poster-availability.cjs');
const file=(type,availability='available')=>({path:'D:/Show/video.mkv',type,availability});
test('special-only works show missing regular despite available videos',()=>{
  for(const type of [1,'extra'])assert.equal(hasMissingRegular({EPDetails:{},RenameBinding:{files:[file(type)]}}),true);
});
test('regular video or collection clears the label without requiring a complete season',()=>{
  for(const f of [file(0),{...file(1),collection:true}])assert.equal(hasMissingRegular({EPDetails:{},RenameBinding:{files:[f]}}),false);
  assert.equal(hasMissingRegular({Eps:12,EPDetails:{EP1:{AbsolutePath:'D:/Show/video.mkv'}}}),false);
});
test('unavailable regular files do not count; alternate usable copies do',()=>{
  const work={EPDetails:{EP1:{Versions:[{path:'D:/Show/video.mkv'}]}},RenameBinding:{files:[file(0,'missing'),{...file(1),path:'D:/Show/SP.mkv'}]}};
  assert.equal(hasMissingRegular(work),true);
  work.EPDetails.EP1.Versions.push({path:'D:/Show/alternative.mkv'});assert.equal(hasMissingRegular(work),false);
  for(const availability of ['empty','unreadable','removed'])assert.equal(hasMissingRegular({RenameBinding:{files:[file(0,availability)]}}),true);
});
test('unknown metadata is not flagged, but a known empty regular list is',()=>{
  assert.equal(hasMissingRegular({}),false);assert.equal(hasMissingRegular({EPDetails:{}}),true);
});
