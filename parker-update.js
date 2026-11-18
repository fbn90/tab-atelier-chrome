import './i18n.js';
import {isTrustedPage} from './extension-pages.js';
import {discoverTabParkers,tabParkerTarget,identifyTabParker,findTabParkerBase} from './youtube-url.js';
import {runExclusive} from './action-coordinator.js';
export const UPDATE_JOURNAL='parkerUpdateHoldV1';
export function installParkerUpdate(api){
  const page=api.runtime.getURL('update-hold.html');
  const read=async()=> (await api.storage.local.get(UPDATE_JOURNAL))[UPDATE_JOURNAL]||[];
  const getTab = id => api.tabs.get(id).catch(() => null);
  const settled = (tab,url) => tab?.url===url && !tab.pendingUrl && tab.status!=='loading';
  // A migrated record is restored to a trusted Parker under a new ID (e.g. after
  // Parker gained a fixed manifest key); otherwise to its original address.
  const restoreUrl = record => record.restoreUrl || record.originalUrl;
  const sameParkedSource = (actual, original) => {
    const target=tabParkerTarget(original,true);
    return !!target && tabParkerTarget(actual,true)===target && new URL(actual).host===new URL(original).host;
  };
  async function waitForTab(id,url,previous,isRestoring=false) {
    for(let attempt=0;attempt<10;attempt++){
      const tab=await getTab(id);
      if(settled(tab,url)||isRestoring&&tab&&!tab.pendingUrl&&tab.status!=='loading'&&sameParkedSource(tab.url,url))return true;
      if(!tab || (tab.url!==url && tab.url!==previous && tab.pendingUrl!==url))return false;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return false;
  }
  const status=async()=>{
    const records=await read(), live=new Map((await api.tabs.query({})).map(tab=>[tab.id,tab]));
    const held=records.filter(record=>settled(live.get(record.tabId),record.holdUrl)).length;
    const preparable=records.filter(record=>!record.restoring&&settled(live.get(record.tabId),record.originalUrl)).length;
    const entries=records.map(record=>{
      const tab=live.get(record.tabId);
      const canPrepare=!record.restoring&&settled(tab,record.originalUrl);
      const canRestore=settled(tab,record.holdUrl)||Boolean(record.restoring&&tab&&!tab.pendingUrl&&tab.status!=='loading'&&sameParkedSource(tab.url,restoreUrl(record)));
      const title=new URL(record.originalUrl).searchParams.get('title')||tabParkerTarget(record.originalUrl)||String(record.tabId);
      return {tabId:record.tabId,title,ownerId:new URL(record.originalUrl).host,canPrepare,canRestore};
    });
    return {ok:true,pending:records.length,held,preparable,entries};
  };
  async function prepare(tabId){
    let records=await read();
    if(!records.length){
      const tabs=await api.tabs.query({});await discoverTabParkers(api,tabs);
      const selected=tabs.filter(tab=>tabParkerTarget(tab.url));
      if(selected.some(tab=>tab.incognito))throw Error(globalThis.atelierI18n.t('ui_update_private'));
      if(selected.some(tab=>!settled(tab,tab.url)))throw Error(globalThis.atelierI18n.t('ui_update_wait'));
      records=selected.map(tab=>({tabId:tab.id,originalUrl:tab.url,windowId:tab.windowId,
        incognito:!!tab.incognito,pinned:!!tab.pinned,holdUrl:`${page}#${encodeURIComponent(tab.url)}`}));
      await api.storage.local.set({[UPDATE_JOURNAL]:records});
    }
    const selected=tabId===undefined?records:records.filter(record=>record.tabId===tabId);
    for(let offset=0;offset<selected.length;offset+=8){
      await Promise.all(selected.slice(offset,offset+8).map(async record=>{
        const tab=await getTab(record.tabId);
        if(record.restoring || !settled(tab,record.originalUrl) || tab.windowId!==record.windowId || !!tab.incognito!==record.incognito)return;
        try{await api.tabs.update(record.tabId,{url:record.holdUrl});await waitForTab(record.tabId,record.holdUrl,record.originalUrl)}catch{}
      }));
    }
    return {...await status(),total:records.length};
  }
  async function restore(tabId,readyOwners=[]){
    const records=await read(), completed=new Set(), skipped=new Set(), owners=new Map();
    function parkerReady(url){
      const id=new URL(url).hostname;
      if(!owners.has(id))owners.set(id,readyOwners.includes(id)?Promise.resolve(true):identifyTabParker(api,id));
      return owners.get(id);
    }
    let unavailable=0,base;
    // Only when the original owner no longer answers: move the placeholder to a
    // pinned or user-paired Parker, keeping title, channel and target unchanged.
    async function migratedUrl(record){
      const found=await (base??=findTabParkerBase(api,[]));
      if(!found)return null;
      const old=new URL(record.originalUrl),next=`${found}parked.html${old.search}${old.hash}`;
      if(new URL(found).host===old.host)return null;
      const target=tabParkerTarget(next);
      return target&&target===tabParkerTarget(record.originalUrl,true)?next:null;
    }
    const selected=tabId===undefined?records:records.filter(record=>record.tabId===tabId);
    for(let offset=0;offset<selected.length;offset+=8){
      const batch=selected.slice(offset,offset+8);
      const ready=[];
      for(const record of batch){
        const tab=await getTab(record.tabId);
        if(tab?.pendingUrl||tab?.status==='loading')continue;
        if(tab&&sameParkedSource(tab.url,restoreUrl(record))){
          if(record.restoring){
            if(await parkerReady(restoreUrl(record)))completed.add(record);
            else unavailable++;
          }else skipped.add(record);
          continue;
        }
        if(!tab||tab.url!==record.holdUrl||!!tab.incognito!==record.incognito){skipped.add(record);continue}
        if(await parkerReady(record.originalUrl)){delete record.restoreUrl;ready.push(record)}
        else{
          const next=await migratedUrl(record);
          if(next){record.restoreUrl=next;ready.push(record)}
          else unavailable++;
        }
      }
      for(const record of ready)record.restoring=true;
      if(ready.length)await api.storage.local.set({[UPDATE_JOURNAL]:records.filter(record=>!completed.has(record)&&!skipped.has(record))});
      await Promise.all(ready.map(async record=>{
        const tab=await getTab(record.tabId);
        if(!settled(tab,record.holdUrl))return;
        try{
          await api.tabs.update(record.tabId,{url:restoreUrl(record)});
          if(await waitForTab(record.tabId,restoreUrl(record),record.holdUrl,true))completed.add(record);
        }catch{}
      }));
    }
    const remaining=records.filter(record=>!completed.has(record)&&!skipped.has(record));
    await api.storage.local.set({[UPDATE_JOURNAL]:remaining});
    return {ok:true,restored:completed.size,skipped:skipped.size,pending:remaining.length,unavailable};
  }
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!['parker-update-status','parker-update-prepare','parker-update-restore'].includes(message?.type))return false;
    const hold=typeof sender.url==='string'&&sender.url.split('#')[0]===page;
    if(sender.id!==api.runtime.id||!(isTrustedPage(sender,api)||hold)){reply({ok:false,error:'Unauthorized'});return false}
    const operation=message.type==='parker-update-status'?status:message.type==='parker-update-prepare'?prepare:restore;
    if(message.tabId!==undefined&&!Number.isInteger(message.tabId)){reply({ok:false,error:"Invalid tab"});return false}
    const readyOwners=isTrustedPage(sender,api)&&Array.isArray(message.readyOwners)
      ?message.readyOwners.filter(id=>typeof id==="string"&&/^[a-p]{32}$/.test(id)):[];
    runExclusive(()=>operation(message.tabId,readyOwners),api).then(reply,error=>reply({ok:false,error:error.message}));return true;
  });
}
