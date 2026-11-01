// A single lightweight request: local entries open in the library; others on Bangumi.
function load({ $, document, store, subjectId, openLocal, openExternal, color }) {
  const section = document.getElementById('ArchiveSubjectRelations');
  const list = document.getElementById('ArchiveSubjectRelationsList');
  const request = Symbol('relations');
  section.request = request;
  section.hidden = true;
  list.replaceChildren();
  if (!subjectId) return;
  $.getJSON('https://api.bgm.tv/v0/subjects/' + encodeURIComponent(subjectId) + '/subjects', data => {
    if (section.request !== request || !Array.isArray(data)) return;
    const works = Object.entries(store.get());
    for (const item of data) {
      if (item.type !== 2 || !/^\d+$/.test(String(item.id))) continue;
      const local = works.find(([key, work]) => /^WorkSaveNo\d+$/.test(key) && work?.ExistCondition === 'Exist' && String(work.bgmID) === String(item.id));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = local ? 'subject-relation subject-relation-local' : 'subject-relation';
      button.textContent = (item.relation || '关联') + ' · ' + (item.name_cn || item.name || item.id);
      if (local) {
        if (color) {
          button.style.setProperty('--relation-color', color(1));
          button.style.setProperty('--relation-background', color(.14));
          button.style.setProperty('--relation-border', color(.5));
        }
        const badge = document.createElement('span');
        badge.className = 'subject-relation-badge';
        badge.textContent = '本地';
        button.appendChild(badge);
      }
      button.title = local ? '打开本地番剧详情' : '在 Bangumi 查看';
      button.onclick = () => local ? openLocal(Number(local[0].slice(10))) : openExternal('https://bgm.tv/subject/' + item.id);
      list.appendChild(button);
    }
    section.hidden = !list.children.length;
  });
}
module.exports = { load };
