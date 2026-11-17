import './i18n.js';
import {runExclusive} from './action-coordinator.js';
import {taskService} from './task-runner.js';
import {isTrustedPage} from './extension-pages.js';
import {installDomainRouting} from './domain-routing.js';
import {readTabSettings,validateTabSettings,AUTOMATION_SETTINGS,isLimitPage} from './tab-settings.js';

import {archiveCandidate,archiveOverflowTab,limitedVideo} from './youtube-overflow.js';
import {reviewProtection} from './inbox-review-protection.js';
import {discoverTabParkers} from './youtube-url.js';

const SESSION='tabAutomationSessionV1',ALARM='tab-automation-continuation';
export function installTabAutomation(api,{inbox,flushEvents=async()=>{},flushEventsInAction=async()=>{}}={}){
  const router=installDomainRouting(api,{flushEventsInAction}),tasks=taskService(api);
  const ages=new Map(), births=new Map();
  let age=0, seeded=false, warning=null, reportedWarning=null;
  const created=new Set(),routes=new Set(),blocked=new Set();
  let timer,timerAt=0,disposed=false,busy=false,saving=Promise.resolve(),graceUntil=0,configuration,lastSaved,alarmArmed,lastError=null,retries=0,routeGeneration=0;
  const ready=Promise.all([api.storage.session.get(SESSION),readTabSettings(api)]).then(([result,settings])=>{
    configuration=settings;
    const savedAges=result[SESSION]?.ages||[];
    for (const [id, order] of savedAges) { ages.set(id,order); age=Math.max(age,order); }
    const value=result[SESSION]||{};graceUntil=value.graceUntil||0;lastError=value.lastError||null;
    for(const id of value.created||[])created.add(id);
    for(const id of value.routes||[])routes.add(id);
    for(const id of value.blocked||[])blocked.add(id);
  });
  const persist=()=>{
    saving=saving.catch(()=>{}).then(async()=>{
      await ready;
      const value={created:[...created],routes:[...routes],blocked:[...blocked],graceUntil,lastError,ages:[...ages]},serialized=JSON.stringify(value);
      if(lastSaved!==serialized){await api.storage.session.set({[SESSION]:value});lastSaved=serialized}
      const needed=created.size>0||routes.size>0||!!lastError;
      if(alarmArmed!==needed){
        if(needed)await api.alarms?.create(ALARM,{periodInMinutes:0.5});else await api.alarms?.clear(ALARM);
        alarmArmed=needed;
      }
    });
    return saving;
  };
  const getTab=async id=>{try{return await api.tabs.get(id)}catch{return null}};
  function schedule(delay=100){
    if(disposed||timer&&timerAt<=Date.now()+delay)return;
    clearTimeout(timer);timerAt=Date.now()+delay;
    timer=setTimeout(()=>{timer=null;process().catch(console.warn)},delay);
  }
  async function focus(tab){try{await api.tabs.update(tab.id,{active:true});await api.windows.update(tab.windowId,{focused:true})}catch{}}
  async function reject(tab,all){
    const live=await getTab(tab.id);if(!live)return;
    const existing=all.find(other=>other.id!==tab.id&&!!other.incognito===!!tab.incognito&&isLimitPage(api,other));
    const notice=existing&&await getTab(existing.id);
    if(notice&&isLimitPage(api,notice)){
      // Only this newly created rejected tab is removed; established tabs are never pruned.
      await api.tabs.remove(live.id);routes.delete(live.id);blocked.delete(live.id);
      await focus(notice);return;
    }
    blocked.add(live.id);routes.delete(live.id);await persist();
    if(!isLimitPage(api,live))await api.tabs.update(live.id,{url:api.runtime.getURL('tab-limit.html')});
    const updated=await getTab(live.id);if(updated){Object.assign(tab,updated);await focus(updated)}
  }
  function syncAges(tabs) {
    const live=new Set(tabs.map(tab=>tab.id));
    for(const id of ages.keys())if(!live.has(id))ages.delete(id);
    const existing=tabs.filter(tab=>!ages.has(tab.id)&&!births.has(tab.id))
      .sort((a,b)=>a.windowId-b.windowId||a.index-b.index);
    for(const tab of existing)ages.set(tab.id,++age);
    for(const id of births.keys())if(live.has(id)&&!ages.has(id))ages.set(id,++age);
    births.clear();seeded=true;
  }

  async function process(){
    if(disposed)return;if(busy){schedule();return}busy=true;let failed=false;
    try{
      await ready;await flushEvents();
      await runExclusive(async()=>{
        const settings=await readTabSettings(api);
        let all=await api.tabs.query({});
        syncAges(all);
        const newIds=new Set(created);
        const review=await reviewProtection(api,all);
        const regularVideo=tab=>!review.protectedTabs.has(tab.id)&&limitedVideo(tab);
        const counted=tab=>!review.markerTabs.has(tab.id)&&!isLimitPage(api,tab);
        warning=null;
        if(settings.youtubeLimitEnabled&&inbox&&Date.now()>=graceUntil){
          await discoverTabParkers(api,all);
          const videoCount=all.filter(regularVideo).length;
          const tabCount=all.filter(counted).length;
          const reviewFillsTotal=review.protectedTabs.size>0&&tabCount-review.protectedTabs.size<=settings.totalLimit;
          const admittedVideos=reviewFillsTotal?0:all.filter(tab=>newIds.has(tab.id)&&regularVideo(tab)).length;
          const excess=Math.max(videoCount-settings.youtubeLimit,
            settings.totalLimitEnabled ? Math.min(admittedVideos,tabCount-settings.totalLimit) : 0);
          let archived=0;
          const candidates=all.filter(tab=>!review.protectedTabs.has(tab.id)&&!newIds.has(tab.id)&&archiveCandidate(tab))
            .sort((a,b)=>ages.get(a.id)-ages.get(b.id));
          if(excess>0&&candidates.length)await persist();
          async function stillOver() {
            const live=await api.tabs.query({});
            const liveReview=await reviewProtection(api,live);
            return live.filter(tab=>!liveReview.protectedTabs.has(tab.id)&&limitedVideo(tab)).length>settings.youtubeLimit||
              admittedVideos&&settings.totalLimitEnabled&&live.filter(t=>!liveReview.markerTabs.has(t.id)&&!isLimitPage(api,t)).length>settings.totalLimit;
          }
          for(const tab of (excess>0?candidates.slice(0,20):[])){
            if(archived>=excess)break;
            // Concurrent user actions can already have brought the counts below both limits.
            if(await archiveOverflowTab(api,inbox,tab,stillOver))archived++;
            else if(!await stillOver())break;
          }
          if(archived){all=await api.tabs.query({});syncAges(all);}
          if(all.filter(regularVideo).length>settings.youtubeLimit){
            warning=globalThis.atelierI18n.t('overflowNoCandidate');
            if(candidates.length>20)schedule(250);
          }
        }
        const current=new Map(all.map(tab=>[tab.id,tab]));
        for(const id of blocked)if(!current.has(id))blocked.delete(id);
        if(settings.totalLimitEnabled&&Date.now()>=graceUntil){
          let count=all.filter(tab=>(!newIds.has(tab.id)||review.admitted.has(tab.id))&&counted(tab)).length;
          for(const id of newIds){
            const tab=current.get(id);if(!tab||review.admitted.has(id)||isLimitPage(api,tab)){created.delete(id);continue}
            if(count<settings.totalLimit)count++;
            else if(!tab.url&&!tab.pendingUrl)continue;
            else await reject(tab,all);
            created.delete(id);
          }
          // A blocked page cannot escape via Back/address-bar navigation while full.
          for(const id of [...blocked]){
            if(newIds.has(id))continue;
            const tab=await getTab(id);if(!tab||isLimitPage(api,tab))continue;
            // The recovery link keeps the same auxiliary tab usable for archiving.
            if((tab.pendingUrl||tab.url)===api.runtime.getURL('inbox.html'))continue;
            const others=(await api.tabs.query({})).filter(other=>other.id!==id&&!isLimitPage(api,other)).length;
            if(others>=settings.totalLimit)await reject(tab,all);else blocked.delete(id);
          }
        }else{created.clear();if(!settings.totalLimitEnabled)blocked.clear()}
        if(!settings.domainRouting)routes.clear();
        await persist();
      },api);
      const settings=await readTabSettings(api);
      if(settings.domainRouting&&routes.size){
        if((await tasks.list()).tasks.some(task=>['queued','running'].includes(task.status))){schedule(300);return}
        const ids=[],generation=routeGeneration;
        const review=await reviewProtection(api,await api.tabs.query({}));
        for(const id of routes){
          const tab=await getTab(id);
          if(!tab||blocked.has(id)||review.admitted.has(id)){routes.delete(id);continue}
          if(tab.pendingUrl||tab.status==='loading')continue;
          ids.push(id);
        }
        await persist();
        if(ids.length){
          await router.start(ids);
          if(generation===routeGeneration)for(const id of ids)routes.delete(id);
          await persist();
        }
      }
      retries=0;if(lastError){lastError=null;await persist()}
    }catch(error){
      failed=true;
      lastError=error.message||globalThis.atelierI18n.t("ui_automatic_check_failed_265747");
      await persist().catch(()=>{});
      schedule(Math.min(30000,250*2**Math.min(retries++,7)));
      console.warn(globalThis.atelierI18n.t("ui_retrying_tab_atelier_automation_c12295"),error);
    }finally{
      const nextWarning=lastError||warning;
      if(reportedWarning!==nextWarning){
        reportedWarning=nextWarning;
        api.runtime.sendMessage({type:'tab-protection-changed'}).catch(()=>{});
      }
      busy=false;if(created.size&&!failed)schedule();
    }
  }
  api.tabs.onCreated.addListener(tab=>{
    if(disposed)return;
    if(seeded)ages.set(tab.id,++age);else births.set(tab.id,true);
    if(!configuration||configuration.totalLimitEnabled||configuration.youtubeLimitEnabled)created.add(tab.id);
    if(!configuration||configuration.domainRouting){routes.add(tab.id);routeGeneration++;}
    schedule();
  });
  api.tabs.onUpdated.addListener((id,change)=>{
    if(disposed)return;
    if(configuration?.youtubeLimitEnabled&&(change.groupId!==undefined||change.url!==undefined||change.pinned!==undefined||change.audible!==undefined||change.status==='complete'))schedule();
    if((change.url!==undefined||change.groupId!==undefined)&&(!configuration||configuration.domainRouting||blocked.has(id)||created.has(id))){if(!configuration||configuration.domainRouting){routes.add(id);routeGeneration++}persist().catch(console.warn);schedule()}
    else if(change.status==='complete'&&(routes.has(id)||created.has(id)||blocked.has(id)))schedule();
  });
  api.storage.onChanged?.addListener((changes,area)=>{
    if(area==='local'&&Object.entries(changes).some(([key,value])=>key.startsWith('inboxReviewV1:')&&value.oldValue?.active&&!value.newValue?.active))schedule();
  });
  api.tabs.onActivated?.addListener(()=>{if(configuration?.youtubeLimitEnabled)schedule()});
  api.tabs.onRemoved.addListener(id=>{if(disposed)return;ages.delete(id);births.delete(id);created.delete(id);routes.delete(id);blocked.delete(id);persist().catch(console.warn);if(configuration?.youtubeLimitEnabled)schedule()});
  api.tabs.onReplaced?.addListener((added,removed)=>{if(disposed)return;if(ages.has(removed)){ages.set(added,ages.get(removed));ages.delete(removed)}if(created.delete(removed))created.add(added);if(blocked.delete(removed))blocked.add(added);routes.delete(removed);routes.add(added);persist().catch(console.warn);schedule()});
  api.runtime.onStartup.addListener(()=>{
    if(disposed)return;
    ready.then(()=>{created.clear();routes.clear();graceUntil=Date.now()+30000;schedule(30000);return persist()}).catch(console.warn);
  });
  api.alarms?.onAlarm.addListener(alarm=>{if(alarm.name===ALARM&&!disposed)schedule(0)});
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(disposed)return false;
    if(!['tab-automation-settings','tab-automation-sort','tab-limit-status','tab-limit-disable'].includes(message?.type))return false;
    const notice=sender?.id===api.runtime.id&&sender.url===api.runtime.getURL('tab-limit.html');
    const trusted=isTrustedPage(sender,api);
    if(!trusted&&!(notice&&['tab-limit-status','tab-limit-disable'].includes(message.type))){reply({ok:false,error:globalThis.atelierI18n.t("ui_unauthorized_message_source_674efb")});return false}
    const action=async()=>{
      await ready;
      if(message.type==='tab-automation-sort'){
        if(!(await readTabSettings(api)).domainRouting)throw Error(globalThis.atelierI18n.t("ui_please_enable_domain_sorting_first_625c47"));
        return router.start((await api.tabs.query({})).map(tab=>tab.id));
      }
      if(message.type==='tab-limit-disable'){
        const settings=await readTabSettings(api);settings.totalLimitEnabled=false;configuration=settings;
        await api.storage.local.set({[AUTOMATION_SETTINGS]:settings});blocked.clear();await persist();return {ok:true,settings};
      }
      if(message.patch!==undefined){
        if(!trusted||message.type!=='tab-automation-settings')throw Error(globalThis.atelierI18n.t("ui_settings_cannot_be_changed_from_here_53bcc4"));
        const patch=validateTabSettings(message.patch),settings={...await readTabSettings(api),...patch};
        await api.storage.local.set({[AUTOMATION_SETTINGS]:settings});configuration=settings;
        if(!settings.domainRouting){routes.clear();for(const task of (await tasks.list()).tasks)if(task.type==='automatic-domain-routing'&&['queued','running'].includes(task.status))await tasks.cancel(task.id)}
        if(!settings.totalLimitEnabled)blocked.clear();await persist();schedule();
      }
      const settings=await readTabSettings(api),all=await api.tabs.query({});
      return {ok:true,settings,count:all.filter(tab=>!isLimitPage(api,tab)).length,warning:lastError||warning};
    };
    (message.type==='tab-automation-sort'?action():runExclusive(action,api)).then(reply,error=>reply({ok:false,error:error.message}));return true;
  });
  ready.then(async()=>{await persist();schedule()}).catch(console.warn);
  return {dispose(){disposed=true;clearTimeout(timer)}};
}
