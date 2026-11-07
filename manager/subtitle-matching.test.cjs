const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chapterBindings}=require('../js/subtitle-matching.cjs');
test('displayed library EP numbers and all versions take precedence over filenames and list positions',()=>{
  const first=path.resolve('media/wrong EP99.mkv'),second=path.resolve('media/no-number.mkv');
  const chapters=chapterBindings({URL:path.dirname(first),EPDetails:{
    EP1:{LocalIndex:1,EpisodeNumber:26,AbsolutePath:first,Versions:[{path:first},{path:second}]},
    EP2:{Collection:true,LocalIndex:2,Versions:[{path:'collection.mkv'}]},
    EP3:{URL:'legacy.mkv'}
  },SPDetails:{SP1:{AbsolutePath:'SP01.mkv'}}});
  assert.deepEqual(chapters,[{id:'EP1',number:26,kind:'EP',videos:[first,second]},
    {id:'EP3',number:3,kind:'EP',videos:[path.resolve('media/legacy.mkv')]}]);
});
