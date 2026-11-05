const {test}=require('node:test');const assert=require('node:assert/strict');
const appearance=require('../js/desktop-appearance.cjs');
function store(){const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};}
test('theme and poster size persist independently and invalid saved preferences fall back safely',()=>{
 const storage=store();assert.deepEqual(appearance.read(storage),{theme:'codex-dark',posterSize:180});appearance.save(storage,'appearance-theme','latte');appearance.save(storage,'appearance-style-version','codex-1');appearance.save(storage,'library-poster-size',240);assert.deepEqual(appearance.read(storage),{theme:'latte',posterSize:240});storage.setItem('appearance-theme','unknown');storage.setItem('library-poster-size','bad');assert.deepEqual(appearance.read(storage),{theme:'codex-dark',posterSize:180});
 const previous=store();previous.setItem('appearance-theme','tokyo-night');previous.setItem('library-poster-size',250);assert.deepEqual(appearance.read(previous),{theme:'codex-dark',posterSize:250});
 assert.equal(appearance.posterSize(50),120);assert.equal(appearance.posterSize(1000),280);assert.equal(appearance.posterSize(184),180);assert.equal(appearance.posterSize(0),180);
});
test('applying a skin remaps all semantic roles and preserves the chosen poster size',()=>{
 const values=new Map();const document={body:{dataset:{},style:{setProperty:(k,v)=>values.set(k,v)}},documentElement:{style:{}}};appearance.applyPosterSize(document,240);
 for(const theme of appearance.THEMES){appearance.applyTheme(document,theme.id);assert.equal(document.body.dataset.theme,theme.id);assert.equal(document.documentElement.style.colorScheme,theme.scheme);assert.equal(values.get('--text'),theme.colors.text);assert.equal(values.get('--bg'),theme.colors.bg);assert.equal(values.get('--poster-size'),'240px');assert.equal(values.get('--control-line'),theme.colors.control);assert.equal(values.get('--sidebar-bg'),theme.colors.sidebarBg);assert.equal(values.has('--sidebar'),false);}
});
function luminance(hex){const rgb=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
test('each skin meets text and control contrast across normal, selected, and semantic states',()=>{
 for(const theme of appearance.THEMES){const c=theme.colors;for(const [fg,bg] of [['text','bg'],['text','panel'],['muted','bg'],['muted','panel'],['muted','input'],['accent','accentBg'],['accentInk','accent'],['success','successBg'],['warning','warningBg'],['danger','dangerBg']])assert.ok(contrast(c[fg],c[bg])>=4.5,theme.id+' '+fg+'/'+bg+' '+contrast(c[fg],c[bg]));assert.ok(contrast(c.control,c.input)>=3,theme.id+' control border');}
});
