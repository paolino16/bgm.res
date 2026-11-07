'use strict';
// Shared line icons and accessible hints for the compact desktop controls.
const paths={
 star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
 starSelected:'<path fill="currentColor" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
 collection:'<rect x="7" y="7" width="14" height="14" rx="2"/><path d="M17 7V3H3v14h4m5-6 5 3-5 3z"/>',
 locate:'<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
 add:'<path d="M12 4v16M4 12h16"/>',
 down:'<path d="m6 9 6 6 6-6"/>',
 up:'<path d="m6 15 6-6 6 6"/>',
 clearRecord:'<path d="M6 3h8l4 4v4M14 3v5h4M6 3v18h5m4-6 6 6m0-6-6 6"/>',
 refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
 folder:'<path d="M3 6h6l2 2h10v11H3z"/>',
 file:'<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h6"/>',
 scan:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 12h10"/>',
 subtitles:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M6 11h5m3 0h4M6 15h3m3 0h6"/>',
 edit:'<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>',
 trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',
 back:'<path d="m10 5-7 7 7 7M3 12h18"/>',
 next:'<path d="m14 5 7 7-7 7M21 12H3"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 checks:'<path d="m2 12 4 4L16 6m-5 10 3 3L24 9"/>',
 external:'<path d="M14 3h7v7m0-7L10 14M9 3H3v18h18v-6"/>',
 settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
 spark:'<path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z"/>',
 save:'<path d="M4 3h13l4 4v14H3V3zM7 3v6h9V3M7 21v-8h10v8"/>',
 play:'<path d="m8 4 12 8-12 8z"/>',
 comments:'<path d="M4 4h16v12H9l-5 4zM8 8h8m-8 4h5"/>',
 undo:'<path d="M4 4v6h6M4 10a8 8 0 1 1 1 8"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 list:'<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
 size:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 8h6"/>',
 archive:'<path d="M3 4h18v5H3zM5 9v12h14V9M9 13h6"/>',
 history:'<path d="M3 5v5h5M3 10a9 9 0 1 1 1 8m8-12v6l4 2"/>',
 skip:'<path d="m5 4 12 8-12 8zM20 4v16"/>'
};
function icon(document,name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','ui-icon');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.innerHTML=paths[name]||paths.file;return svg;}
function actionStyle(text){
 const label=String(text).trim();
 if(/^(设为默认字幕组|默认字幕组)$/.test(label))return [label==='默认字幕组'?'starSelected':'star',true];
 if(/^(设为合集|合集设置 \/ 重命名)$/.test(label))return ['collection',true];
 if(label==='打开')return ['play',true];
 if(label==='定位')return ['locate',true];
 if(label==='删除文件')return ['trash',true];
 if(/^(清除记录|清除本番记录|清除全部异常记录)$/.test(label))return ['clearRecord',true];
 if(/^(重试|重试核对|刷新删除清单)$/.test(label))return ['refresh',true];
 if(label==='添加归属')return ['add',true];
 if(label==='载入作品')return ['next',true];
 if(label==='预览条目目录迁移')return ['folder',true];
 if(label==='打开资源整理')return ['archive',true];
 if(label==='查看异常文件')return ['file',true];
 if(label==='打开所在目录')return ['folder',true];
 if(label==='确认全部')return ['checks',true];
 if(/^(展开|收起)$/.test(label))return [label==='展开'?'down':'up',true];
 if(/^(?:(?:↻\s*)?刷新(?:任务)?|检查文件中…)$/.test(label))return ['refresh',true];
 if(/^(?:←\s*)?返回/.test(label))return ['back',true];
 if(/^(关闭|取消选择|清空)$/.test(label))return ['close',true];
 if(/^(上一页|下一页)$/.test(label))return [label==='上一页'?'back':'next',true];
 if(/^(检测全库字幕|检测本剧字幕|重新检测|正在检测…|检测字幕 \d+\/\d+)/.test(label))return ['scan',true];
 if(/^(打开.*文件夹|选择目录)$/.test(label))return ['folder',true];
 if(/^选择.*文件/.test(label))return ['file',true];
 if(/^(修改识别信息|编辑信息)$/.test(label))return ['edit',true];
 if(/^删除记录/.test(label))return ['trash',true];
 if(/^重新识别/.test(label))return ['refresh',true];
 if(/^(放弃此方案|取消本次重新识别)$/.test(label))return ['close',true];
 if(/^Bangumi/.test(label))return ['external',true];
 if(/^(导入字幕|导入外挂字幕)$/.test(label))return ['subtitles',true];
 if(/^(全部标为看过|✓ 已看过|✓ 看过)$/.test(label))return ['check',true];
 if(/^(海报视图|列表视图)$/.test(label))return [label==='海报视图'?'grid':'list',true];
 if(/^整理设置$/.test(label))return ['settings',true];
 if(/^整理任务$/.test(label))return ['list',false,'任务'];
 if(/^审核文件方案$/.test(label))return ['checks',false,'核对方案'];
 if(/^识别并预览$/.test(label))return ['scan',false,'识别'];
 if(/^确认映射$|^已确认$/.test(label))return ['check',true];
 if(/^确认筛选映射/.test(label))return ['checks',true];
 if(/^更新检查$/.test(label))return ['scan',true];
 if(/^AI (辅助映射|后台识别中)/.test(label))return ['spark',false,label.includes('后台')?'识别中…':'AI 映射'];
 if(/^(?:▶\s*)?(播放|继续播放)$/.test(label))return ['play',true];
 if(/^评论(?: ↗)?$/.test(label))return ['comments',true];
 if(/^看过$/.test(label))return ['check',true];
 if(/^撤销已看$/.test(label))return ['undo',true];
 if(/^看到这里$/.test(label))return ['checks',true];
 if(/^(保存|确认并导入)/.test(label))return ['save',false];
 if(/^执行入库/.test(label))return ['archive',false];
 if(/^(匹配预览|重新预览)/.test(label))return ['scan',false,'预览'];
 if(/^全选/.test(label))return ['checks',true];
 if(/^查看最近 AI/.test(label))return ['history',true];
 if(/^归为附加/.test(label))return ['archive',true];
 if(/^跳过选中/.test(label))return ['skip',true];
 return null;
}
function decorateButton(el,text){const style=actionStyle(text);if(!style)return el;const [name,only,short]=style;const document=el.ownerDocument;el.dataset.uiIcon=name;if(only)el.dataset.iconOnly='';else delete el.dataset.iconOnly;el.setAttribute('aria-label',text);const label=document.createElement('span');label.className='control-label';label.textContent=short||text;el.replaceChildren(icon(document,name),label);return el;}
function install({document,window}){
 const tooltip=document.createElement('div');tooltip.className='control-tooltip';tooltip.id='control-tooltip';tooltip.setAttribute('role','tooltip');tooltip.hidden=true;document.body.appendChild(tooltip);let active=null,timer=0,previousDescription=null;
 const migratedTitles=new WeakMap();
 function migrateTitle(el){if(!el.hasAttribute('title'))return;const text=el.getAttribute('title');if(text)el.dataset.tooltip=text;else if(el.dataset.tooltip===migratedTitles.get(el))delete el.dataset.tooltip;migratedTitles.set(el,text);el.removeAttribute('title');}
 function migrateTree(el){if(el.nodeType!==1)return;migrateTitle(el);for(const child of el.querySelectorAll('[title]'))migrateTitle(child);}
 function hide(){window.clearTimeout(timer);if(active){if(previousDescription)active.setAttribute('aria-describedby',previousDescription);else active.removeAttribute('aria-describedby');}active=null;previousDescription=null;tooltip.hidden=true;}
 function show(control,immediate=false){hide();if(!control)return;active=control;previousDescription=control.getAttribute('aria-describedby');timer=window.setTimeout(()=>{if(!control.isConnected)return;const label=control.dataset.tooltip||control.getAttribute('aria-label');if(!label)return;tooltip.textContent=label;tooltip.hidden=false;control.setAttribute('aria-describedby',[previousDescription,tooltip.id].filter(Boolean).join(' '));const box=control.getBoundingClientRect(),hint=tooltip.getBoundingClientRect(),rail=control.closest('.sidebar');let left=rail?box.right+12:box.left+(box.width-hint.width)/2,top=rail?box.top+(box.height-hint.height)/2:box.bottom+8;if(top+hint.height>window.innerHeight-8)top=box.top-hint.height-8;tooltip.style.left=Math.max(8,Math.min(left,window.innerWidth-hint.width-8))+'px';tooltip.style.top=Math.max(8,top)+'px';},immediate?0:350);}
 const find=target=>target?.closest?.('[data-ui-icon],[data-tooltip],.view-switch button,.scroll-float');
 document.addEventListener('pointerover',event=>{const control=find(event.target);if(control&&control!==active)show(control);});
 document.addEventListener('pointerout',event=>{if(active&&!active.contains(event.relatedTarget))hide();});
 document.addEventListener('focusin',event=>show(find(event.target),true));document.addEventListener('focusout',hide);document.addEventListener('pointerdown',hide);document.addEventListener('keydown',event=>{if(event.key==='Escape')hide();});window.addEventListener('blur',hide);document.addEventListener('scroll',hide,true);
 for(const nav of document.querySelectorAll('[data-nav]')){nav.setAttribute('aria-label',nav.textContent.replace(/\d+/g,'').trim());nav.dataset.tooltip=nav.getAttribute('aria-label');for(const child of [...nav.childNodes])if(child.nodeType===3){const label=document.createElement('span');label.className='nav-label';label.textContent=child.textContent;child.replaceWith(label);}}
 for(const control of document.querySelectorAll('#poster-size-control')){control.dataset.tooltip='海报大小';control.prepend(icon(document,'size'));}
 for(const el of document.querySelectorAll('.header-actions button,#library-back'))decorateButton(el,el.textContent);
 migrateTree(document.body);
 const observer=new window.MutationObserver(records=>{if(active&&!active.isConnected)hide();for(const record of records){const el=record.target;if(record.type==='attributes'){if(el.hasAttribute('title')){migrateTitle(el);if(active===el&&!tooltip.hidden)show(el,true);}continue;}for(const added of record.addedNodes)migrateTree(added);if(el.nodeType===1&&el.matches('button[data-ui-icon]')&&!el.querySelector('svg'))decorateButton(el,el.textContent);}});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['title']});
 return {hide,destroy(){hide();observer.disconnect();tooltip.remove();}};
}
module.exports={icon,actionStyle,decorateButton,install};
