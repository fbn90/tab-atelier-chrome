export function domainGroups(tabs) {
  const groups = new Map();
  for (const tab of tabs) {
    if (!groups.has(tab.domain)) groups.set(tab.domain,{key:tab.domain,label:tab.domain,count:0,tabIds:[]});
    const group=groups.get(tab.domain);group.count++;group.tabIds.push(tab.id);
  }
  return [...groups.values()];
}

// Search finds groups. Their counts and actions always describe the full group.
export function visibleGroups(groups, tabsById, {search='',minimum=1,sort='count'}={}) {
  const query=search.trim().toLocaleLowerCase('de');
  return groups.filter(group=>group.count>=minimum && (!query ||
    group.label.toLocaleLowerCase('de').includes(query) || group.tabIds.some(id=>{
      const tab=tabsById.get(id);
      return `${tab?.title||''} ${tab?.url||''}`.toLocaleLowerCase('de').includes(query);
    }))).sort((a,b)=>(sort==='count' ? b.count-a.count : 0) || a.label.localeCompare(b.label,'de'));
}
