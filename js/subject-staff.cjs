// Display only the requested production roles, in the user's preferred order.
const roles=[
  ['总监督',['总监督','总导演','総監督']],
  ['系列监督',['系列监督','系列导演','シリーズ監督','シリーズディレクター']],
  ['监督',['监督','导演','監督']],
  ['副监督',['副监督','副导演','副監督']],
  ['系列构成',['系列构成','系列構成','シリーズ構成']],
  ['脚本',['脚本','腳本']],
  ['制作公司',['动画制作','動畫製作','アニメーション制作','制作公司']]
];
function values(value){
  if(typeof value==='string')return value.trim()?[value.trim()]:[];
  if(Array.isArray(value))return value.flatMap(values);
  return value&&typeof value==='object'?values(value.v):[];
}
function subjectStaff(subject,persons=[]){
  const infobox=Array.isArray(subject?.infobox)?subject.infobox:[];
  const rows=roles.flatMap(([label,aliases])=>{
    const listed=[...new Set(infobox.filter(item=>aliases.includes(item.key)).flatMap(item=>values(item.value)))];
    const linked=(Array.isArray(persons)?persons:[]).filter(person=>aliases.includes(person.relation)&&values(person.name).length);
    const identities=new Map();
    for(const person of linked)for(const name of [...values(person.name),...values(person.name_cn)]){
      if(!identities.has(name))identities.set(name,new Set());
      if(/^[1-9]\d*$/.test(String(person.id)))identities.get(name).add(String(person.id));
    }
    const names=[...identities.keys()].sort((a,b)=>b.length-a.length),seen=new Set(),parts=[];
    function append(text){
      if(parts.length)parts.push({text:'、'});
      let start=0,index=0;
      while(index<text.length){
        const name=names.find(name=>text.startsWith(name,index)&&
          !/[\p{L}\p{N}_]/u.test(text[index-1]||'')&&!/[\p{L}\p{N}_]/u.test(text[index+name.length]||''));
        if(!name){index++;continue;}
        if(index>start)parts.push({text:text.slice(start,index)});
        const ids=identities.get(name),id=ids.size===1?[...ids][0]:undefined;
        parts.push(id?{text:name,id}:{text:name});seen.add(name);
        for(const person of linked)if(person.name===name||person.name_cn===name){seen.add(person.name);seen.add(person.name_cn);}
        index+=name.length;start=index;
      }
      if(start<text.length)parts.push({text:text.slice(start)});
    }
    for(const text of listed)append(text);
    for(const person of linked)if(!seen.has(person.name)){append(person.name);seen.add(person.name);}
    return parts.length?[{label,value:parts.map(part=>part.text).join(''),parts}]:[];
  });
  return rows.some(row=>row.label==='系列构成')?rows.filter(row=>row.label!=='脚本'):rows;
}
module.exports={subjectStaff};
