function normalizeAirDate(value){
  if(typeof value!=='string')return '';
  const match=/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim());
  if(!match||Number(match[1])===0)return '';
  const year=Number(match[1]),month=Number(match[2]||0),day=Number(match[3]||0);
  if(match[2]&&(month<1||month>12))return '';
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  if(match[3]&&(day<1||day>days[month-1]))return '';
  return match[0];
}
function airDate(work){return normalizeAirDate(work.AirDate)||normalizeAirDate(String(work.Year||''));}
function airDateLabel(work){const date=airDate(work);return date?'开播：'+date+(date.length===10?'':'（具体日期未知）'):'开播日期未知';}
function compareAirDates(a,b){
  const key=work=>{const date=airDate(work);if(!date)return 0;const parts=date.split('-');return Number(parts[0])*10000+Number(parts[1]||0)*100+Number(parts[2]||0);};
  return key(b)-key(a)||String(a.Name||'').localeCompare(String(b.Name||''),'zh-CN',{numeric:true});
}
module.exports={normalizeAirDate,airDate,airDateLabel,compareAirDates};
