'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {recordScope,relatedTask}=require('../js/organizer-records.cjs');

test('detail record lookup matches exact subject IDs, multi-subject tasks and linked task IDs',()=>{
  const scope=recordScope({bgmID:12,Name:'动画',RenameBinding:{
    files:[{taskId:'one',parentTaskIds:['parent']},{taskId:'one'}],
    resources:[{taskId:'extra'}],invalidResources:[{taskId:'missing'}]
  }});
  assert.deepEqual(scope.taskIds,['one','parent','extra','missing']);
  assert.equal(relatedTask({uuid:'other',subject_id:'12'},scope),true);
  assert.equal(relatedTask({uuid:'other',bgm_id:12},scope),true);
  assert.equal(relatedTask({uuid:'other',subject_ids:[99,'12']},scope),true);
  for(const uuid of scope.taskIds)assert.equal(relatedTask({uuid,bgm_id:99},scope),true);
  assert.equal(relatedTask({uuid:'other',subject_id:123,name:'动画',path:'D:/12'},scope),false);
});

test('without a valid subject ID record lookup uses the work name without matching everything',()=>{
  const scope=recordScope({Name:'Anime'});
  assert.equal(relatedTask({name:'ANIME BD'},scope),true);
  assert.equal(relatedTask({name:'Other',path:'D:/Anime/BD'},scope),true);
  assert.equal(relatedTask({name:'Other'},scope),false);
  assert.equal(relatedTask({name:'Anything'},recordScope({})),false);
  assert.equal(recordScope({bgmID:'0',Name:'Anime'}).subjectId,'');
});
