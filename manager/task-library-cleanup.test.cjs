const {test}=require('node:test');const assert=require('node:assert/strict');
const {removedWorks}=require('../js/task-library-cleanup.cjs');
test('task deletion removes only sole-task imported works and preserves shared or legacy works',()=>{
 const data={WorkSaveNo1:{RenameBinding:{files:[{taskId:'one'},{taskId:'one'}]}},WorkSaveNo2:{RenameBinding:{files:[{taskId:'one'},{taskId:'two'}]}},WorkSaveNo3:{EPDetails:{}},WorkSaveNo4:{RenameBinding:{files:[]}},WorkSaveNo5:{RenameBinding:{files:[{taskId:'two'}]}}};
 assert.deepEqual(removedWorks(data,'one'),['WorkSaveNo1']);
});
