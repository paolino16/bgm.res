const {test}=require('node:test');const assert=require('node:assert/strict');
const {subjectStaff}=require('../js/subject-staff.cjs');
test('production roles follow requested order, normalize aliases and omit absent values',()=>{
 const rows=subjectStaff({infobox:[{key:'动画制作',value:'Studio'},{key:'副导演',value:[{v:'A'},{v:'B'}]},{key:'导演',value:'C'},{key:'总导演',value:'D'},{key:'系列构成',value:'E'},{key:'系列导演',value:'F'},{key:'监督',value:'C'},{key:'音响监督',value:'not included'},{key:'製作',value:'committee'}]});
 assert.deepEqual(rows.map(row=>row.label),['总监督','系列监督','监督','副监督','系列构成','制作公司']);
 assert.deepEqual(rows.map(row=>row.value),['D','F','C','A、B','E','Studio']);
 assert.deepEqual(subjectStaff({infobox:[{key:'导演',value:' '},{key:'动画制作',value:null}]}),[]);
 assert.deepEqual(subjectStaff({}),[]);
});

test('animation studio falls back to related staff when missing from infobox',()=>{
 const subject={id:513878,infobox:[{key:'导演',value:'五十嵐海'},{key:'製作',value:'CD Projekt Red'}]};
 const persons=[{name:'TRIGGER',relation:'动画制作'},{name:'TRIGGER',relation:'动画制作'},{name:'Other',relation:'製作'},{name:'五十嵐海',relation:'导演'}];
 assert.deepEqual(subjectStaff(subject,persons).map(({label,value})=>({label,value})),[{label:'监督',value:'五十嵐海'},{label:'制作公司',value:'TRIGGER'}]);
 assert.deepEqual(subjectStaff(subject,null).map(({label,value})=>({label,value})),[{label:'监督',value:'五十嵐海'}]);
});

test('staff merges missing names and links only unambiguous matching identities in the same role',()=>{
 const rows=subjectStaff({infobox:[{key:'导演',value:'田中（1–3话）、田中太郎、未关联者'},{key:'系列构成',value:'Writer'}]},[
  {id:1,name:'田中',relation:'导演'},{id:2,name:'新增监督',relation:'导演'},
  {id:99,name:'未关联者',relation:'原画'},{id:3,name:'Writer',relation:'系列构成'},
  {id:4,name:'Studio',relation:'动画制作'}]);
 assert.equal(rows[0].value,'田中（1–3话）、田中太郎、未关联者、新增监督');
 assert.deepEqual(rows[0].parts.filter(p=>p.id),[{text:'田中',id:'1'},{text:'新增监督',id:'2'}]);
 assert.deepEqual(rows[1].parts,[{text:'Writer',id:'3'}]);
 assert.deepEqual(rows[2].parts,[{text:'Studio',id:'4'}]);
 const ambiguous=subjectStaff({},[{id:1,name:'同名',relation:'导演'},{id:2,name:'同名',relation:'导演'}]);
 assert.deepEqual(ambiguous[0].parts,[{text:'同名'}]);
});
test('all six requested roles can be provided entirely by related staff',()=>{
 const rows=subjectStaff({},['总导演','系列导演','导演','副导演','系列构成','动画制作'].map((relation,i)=>({relation,name:'姓名'+i,id:i+1})));
 assert.deepEqual(rows.map(row=>row.label),['总监督','系列监督','监督','副监督','系列构成','制作公司']);
 assert.ok(rows.every(row=>row.parts[0].id));
});
