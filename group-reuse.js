export function groupNameKey(title) {
  return typeof title==='string'?title.normalize('NFKC').toLocaleLowerCase('de').replace(/\s+/gu,''):'';
}

// Titles are compared exactly after case/space normalization, never by substring.
export async function reusableGroupPlan(api,title,{contexts=[false,true],sourceWindowId}={}) {
  const key=groupNameKey(title);
  if(!key)return {targets:{},records:[]};
  const named=(await api.tabGroups.query({})).filter(group=>!group.shared&&groupNameKey(group.title)===key);
  if(!named.length)return {targets:{},records:[]};
  const tabs=await api.tabs.query({windowType:'normal'}),targets={},records=[];
  const windows=new Map();
  for(const group of named) {
    if(!windows.has(group.windowId)) {
      try{windows.set(group.windowId,await api.windows.get(group.windowId))}catch{windows.set(group.windowId,null)}
    }
  }
  for(const incognito of contexts) {
    const candidates=named.map(group=>({group,window:windows.get(group.windowId),members:tabs.filter(tab=>tab.groupId===group.id&&tab.windowId===group.windowId&&!!tab.incognito===!!incognito)}))
      .filter(item=>item.window?.type==='normal'&&!!item.window.incognito===!!incognito&&item.members.length)
      .sort((a,b)=>b.members.length-a.members.length||a.group.id-b.group.id);
    const target=candidates[0];if(!target)continue;
    targets[String(!!incognito)]={groupId:target.group.id,windowId:target.group.windowId};
    for(const item of candidates) {
      // A window filter limits additional source groups; it never broadens them.
      if(sourceWindowId!==undefined&&item.group.id!==target.group.id&&item.group.windowId!==sourceWindowId)continue;
      for(const tab of item.members.sort((a,b)=>a.index-b.index||a.id-b.id))records.push({tabId:tab.id,url:tab.url,windowId:tab.windowId,
        incognito:!!tab.incognito,pinned:!!tab.pinned,sourceGroupId:item.group.id,reuseMember:true});
    }
  }
  return {targets,records};
}
