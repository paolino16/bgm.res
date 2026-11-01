const escapeAttribute=value=>String(value||'').replace(/[&"'<>]/g,c=>({'&':'&amp;','"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;'}[c]));
function mountCovers(container,Observer=globalThis.IntersectionObserver){
  container.coverObserver?.disconnect();
  const load=card=>{if(card.dataset.cover){card.style.backgroundImage='url('+JSON.stringify(card.dataset.cover)+')';delete card.dataset.cover;}};
  const cards=container.querySelectorAll('[data-cover]');
  if(!Observer){for(const card of cards)load(card);return;}
  const observer=new Observer(entries=>{for(const entry of entries)if(entry.isIntersecting){load(entry.target);observer.unobserve(entry.target);}},{root:container,rootMargin:'300px 0px'});
  container.coverObserver=observer;for(const card of cards)observer.observe(card);
}
module.exports={escapeAttribute,mountCovers};
