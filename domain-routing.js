import './i18n.js';
import {domainOf,tabUrl} from './tab-rules.js';
import {transferStep} from './tab-transfer.js';
import {taskService} from './task-runner.js';
import {isGrouped,DOMAIN_TARGETS,domainWindowTargets,rememberDomainWindow,domainContext} from './window-policy.js';
import {readTabSettings} from './tab-settings.js';

const routable=tab=>!tab.pinned&&!isGrouped(tab)&&/^https?:\/\//i.test(tabUrl(tab));
export function installDomainRouting(api,{flushEventsInAction=async()=>{}}={}){
  const tasks=taskService(api);
  // Retire persisted jobs from the old ten-tabs-per-window rule without moving anything.
  tasks.register('automatic-window-limit',async()=>true);
  tasks.register('automatic-domain-routing',async(job,ctx)=>{
    if(!(await readTabSettings(api)).domainRouting)return true;
    await flushEventsInAction();
    if(!job.prepared){
      const all=await api.tabs.query({}),wanted=new Set(job.payload.tabIds);
      const pool=await domainWindowTargets(api),windows=new Map();
      const savedPool=JSON.stringify(pool),windowInfo=new Map();
      const getWindow=id=>{
        if(!windowInfo.has(id))windowInfo.set(id,api.windows.get(id).catch(()=>null));
        return windowInfo.get(id);
      };
      for(const tab of all){if(!windows.has(tab.windowId))windows.set(tab.windowId,[]);windows.get(tab.windowId).push(tab)}
      for(const key of Object.keys(pool)){
        const win=await getWindow(pool[key]);
        if(!win||win.type!=='normal'||!windows.has(win.id)||String(!!win.incognito)!==key.split('|')[0])delete pool[key];
      }
      // Prefer an explicit domain window, otherwise an already pure domain window.
      for(const [id,members] of windows){
        if(!members.every(tab=>/^https?:\/\//i.test(tabUrl(tab))))continue;
        const contexts=new Set(members.map(domainContext));
        if(contexts.size!==1)continue;
        const win=await getWindow(id);
        if(win?.type==='normal')pool[[...contexts][0]]??=id;
      }
      const records=[];
      for(const tab of all.filter(tab=>wanted.has(tab.id)&&routable(tab))){
        const win=await getWindow(tab.windowId);
        if(win?.type!=='normal'||pool[domainContext(tab)]===tab.windowId)continue;
        records.push({id:tab.id,url:tab.url,pendingUrl:tab.pendingUrl,windowId:tab.windowId,pinned:!!tab.pinned,incognito:!!tab.incognito,wasForeground:!!win.focused&&!!tab.active});
      }
      if(savedPool!==JSON.stringify(pool))await api.storage.session.set({[DOMAIN_TARGETS]:pool});
      job.pool=pool;job.prepared=true;job.total=records.length;await ctx.write(records);
    }
    const records=await ctx.read();
    const done=await transferStep(job,ctx,records,{api,destinationKey:domainContext,initialDestinations:job.pool,
      matches:(tab,record)=>routable(tab)&&tabUrl(tab)===tabUrl(record)&&!!tab.incognito===!!record.incognito});
    const contextRecords=new Map(records.map(record=>[domainContext(record),record]));
    for(const [key,id] of Object.entries(job.transfer.destinations)){
      const record=contextRecords.get(key);
      if(record)await rememberDomainWindow(api,id,record);
    }
    if(!done)return false;
    const front=[...job.transfer.arrived].reverse().find(item=>records[item.recordIndex].wasForeground);
    if(front&&!job.focusDone)await ctx.effect(async()=>{
      const record=records[front.recordIndex];let tab,source;
      try{tab=await api.tabs.get(front.id);source=await api.windows.get(record.windowId)}catch{}
      if(source?.focused&&tab?.windowId===front.windowId&&tabUrl(tab)===tabUrl(record)){
        await api.tabs.update(tab.id,{active:true});await api.windows.update(tab.windowId,{focused:true});
      }
      job.focusDone=true;
    });
    job.phase=globalThis.atelierI18n.t("ui_tabs_collected_by_domain_fe01cf");return true;
  });
  return {async start(tabIds){return tasks.start('automatic-domain-routing',{tabIds},globalThis.atelierI18n.t("ui_automatically_collect_tabs_by_domain_f5b1b5"))}};
}
