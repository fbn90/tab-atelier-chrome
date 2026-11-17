import './i18n.js';
import {runExclusive} from './action-coordinator.js';
import {isLimitPage,readTabSettings} from './tab-settings.js';
import {discoverTabParkers,findTabParkerBase,inboxParkedUrl,parseYouTubeTab} from './youtube-url.js';
import {bindReview,readReview,removeReview,reviewId,reviewPage,reviewProtection,reviewToken,saveReview} from './inbox-review-protection.js';

const t=(key,...values)=>globalThis.atelierI18n.t(key,values);
const getTab=(api,id)=>api.tabs.get(id).catch(()=>null);

export async function previewReview(api,ids){
  const [tabs,settings]=await Promise.all([api.tabs.query({}),readTabSettings(api)]);
  const opened=new Set(tabs.map(reviewId).filter(Boolean));
  const fresh=ids.filter(id=>!opened.has(id)).length;
  const {protectedTabs,markerTabs}=await reviewProtection(api,tabs);
  const total=tabs.filter(tab=>!markerTabs.has(tab.id)&&!isLimitPage(api,tab)).length;
  const videos=tabs.filter(tab=>!protectedTabs.has(tab.id)&&reviewId(tab)).length;
  return {count:ids.length,fresh,needsException:fresh>0&&(
    settings.totalLimitEnabled&&total+fresh>settings.totalLimit||
    settings.youtubeLimitEnabled&&videos+fresh>settings.youtubeLimit)||
    settings.youtubeLimitEnabled&&ids.length>settings.youtubeLimit};
}

export function installInboxReview({api,tasks,store}){
  const findMarker=async job=>{
    const url=reviewPage(api,job.id);
    const markers=(await api.tabs.query({})).filter(tab=>!tab.incognito&&(tab.pendingUrl||tab.url)===url);
    if(markers.length>1)throw Error(t('reviewWindowChanged'));
    if(job.markerSeen&&!markers.length)throw Error(t('reviewWindowChanged'));
    return markers[0];
  };
  async function markerFor(job,ctx){
    let marker=await findMarker(job);
    if(!marker){
      const url=reviewPage(api,job.id);
      if(job.payload.target==='current') {
        const window=await api.windows.get(job.payload.windowId).catch(()=>null);
        if(window?.type!=='normal'||window.incognito)throw Error(t('reviewWindowChanged'));
      }
      await ctx.effect(async()=>{
        if(job.payload.target==='current')await api.tabs.create({url,windowId:job.payload.windowId,active:false});
        else await api.windows.create({url,focused:false,incognito:false,type:'normal'});
      });
      if(ctx.cancelled())return null;
      marker=await findMarker(job);
      if(!marker)throw Error(t('reviewWindowChanged'));
    }
    if(job.windowId!==undefined&&marker.windowId!==job.windowId)throw Error(t('reviewWindowChanged'));
    job.markerSeen=true;job.windowId=marker.windowId;
    await ctx.checkpoint();
    if(marker.groupId<0){
      if(job.groupId!==undefined)throw Error(t('reviewWindowChanged'));
      await ctx.effect(async()=>{await api.tabs.group({tabIds:[marker.id],createProperties:{windowId:marker.windowId}})});
      if(ctx.cancelled())return null;
      marker=await getTab(api,marker.id);
    }
    if(!marker||marker.groupId<0||job.groupId!==undefined&&job.groupId!==marker.groupId)throw Error(t('reviewWindowChanged'));
    const group=await api.tabGroups.get(marker.groupId);
    if(group.shared)throw Error(t('reviewWindowChanged'));
    if(job.groupId===undefined){
      await api.tabGroups.update(group.id,{title:job.payload.title,color:'green'});
      await bindReview(api,job.id,marker);
      job.groupId=group.id;await ctx.checkpoint();
    }
    return marker;
  }
  tasks.register('inbox-review-open',async(job,ctx)=>{
    const {videoIds,bypass}=job.payload;
    job.total=videoIds.length;
    job.phase=t('reviewOpening');
    if(job.complete){
      if(job.keepProtection)return true;
      const markers=(await api.tabs.query({})).filter(tab=>reviewToken(api,tab.pendingUrl||tab.url)===job.id);
      if(markers.length===1)await api.tabs.remove(markers[0].id).catch(()=>{});
      await removeReview(api,job.id);
      return true;
    }
    let protection=await readReview(api,job.id);
    if(!protection){
      if(job.markerSeen)throw Error(t('reviewWindowChanged'));
      if(!bypass&&(await previewReview(api,videoIds)).needsException)throw Error(t('reviewCapacityChanged'));
      protection={active:true,bypass,title:job.payload.title,members:[]};
      await saveReview(api,job.id,protection);
    }
    if(!protection.active)throw Error(t('reviewWindowChanged'));
    const marker=await markerFor(job,ctx);
    if(!marker)return false;
    const summarize=()=>{job.result={ok:true,createdTabs:job.created||0,reusedTabs:job.reused||0,
      groupedTabs:protection.members.length,skipped:job.skipped||0,limitSkipped:job.limitSkipped||0};};
    const inventory=await api.tabs.query({});
    await discoverTabParkers(api,inventory.filter(tab=>!tab.incognito));
    const parkerBase=await findTabParkerBase(api,inventory);
    const groups=await api.tabGroups.query({});
    const shared=new Set(groups.filter(group=>group.shared).map(group=>group.id));
    const candidates=new Map();
    for(const tab of inventory){
      const id=reviewId(tab);
      if(!id)continue;
      if(!candidates.has(id))candidates.set(id,[]);
      candidates.get(id).push(tab);
    }
    for(const id of videoIds.slice(job.cursor,job.cursor+5)){
      if(ctx.cancelled())return false;
      await ctx.effect(async()=>{
        const anchor=await getTab(api,marker.id);
        if(anchor?.windowId!==job.windowId||anchor.groupId!==job.groupId||
          reviewToken(api,anchor.pendingUrl||anchor.url)!==job.id)throw Error(t('reviewWindowChanged'));
        const progress=()=>{
          job.cursor++;job.processed=job.cursor;summarize();
        };
        if(protection.members.includes(id)){progress();return}
        let existing=candidates.get(id)||[];
        if(!existing.length)existing=(await api.tabs.query({})).filter(tab=>reviewId(tab)===id);
        const pending=protection.pending;
        const priorCreations=pending?.videoId===id&&pending.create
          ? existing.filter(tab=>tab.windowId===job.windowId&&!pending.before.includes(tab.id)):[];
        if(priorCreations.length>1)throw Error(t('reviewWindowChanged'));
        const inside=existing.find(tab=>tab.windowId===job.windowId&&tab.groupId===job.groupId);
        let selected=inside||priorCreations[0]||existing.find(tab=>!tab.pinned&&!shared.has(tab.groupId)&&parseYouTubeTab(tab.pendingUrl||tab.url));
        const alreadyOpen=!!selected&&!priorCreations.some(tab=>tab.id===selected.id);
        if(existing.length&&!selected){job.skipped=(job.skipped||0)+1;progress();return}
        if(selected){
          const live=await getTab(api,selected.id);
          if(reviewId(live)!==id||live.windowId!==selected.windowId||live.groupId!==selected.groupId||live.pinned||
            live.groupId>=0&&(await api.tabGroups.get(live.groupId).catch(()=>null))?.shared){
            job.skipped=(job.skipped||0)+1;progress();return;
          }
          selected=live;
        }
        if(!selected&&!bypass&&(await previewReview(api,[id])).needsException){
          job.limitSkipped=(job.limitSkipped||0)+1;progress();return;
        }
        const create=!selected;
        if(create){
          const item=await store.get(id);
          if(!item){job.skipped=(job.skipped||0)+1;progress();return}
          protection.pending={videoId:id,markerId:marker.id,create:true,before:existing.map(tab=>tab.id)};
          await saveReview(api,job.id,protection);
          if(ctx.cancelled())return;
          const url=inboxParkedUrl(parkerBase,item.openUrl,item.title,item.channel);
          selected=await api.tabs.create({url,windowId:job.windowId,active:false});
          protection.pending.tabId=selected.id;
          await saveReview(api,job.id,protection);
        }else{
          protection.pending={videoId:id,markerId:marker.id,tabId:selected.id};
          await saveReview(api,job.id,protection);
          if(ctx.cancelled())return;
          if(selected.windowId!==job.windowId)selected=await api.tabs.move(selected.id,{windowId:job.windowId,index:-1});
        }
        let live=await getTab(api,selected.id);
        for(let attempt=0;live&&!live.url&&!live.pendingUrl&&attempt<10;attempt++){
          await new Promise(resolve=>setTimeout(resolve,50));
          live=await getTab(api,selected.id);
        }
        if(reviewId(live)!==id||live.windowId!==job.windowId||live.pinned)throw Error(t('reviewWindowChanged'));
        const destination=await getTab(api,marker.id);
        if(destination?.groupId!==job.groupId||destination.windowId!==job.windowId||
          (await api.tabGroups.get(job.groupId)).shared)throw Error(t('reviewWindowChanged'));
        if(live.groupId!==job.groupId)await api.tabs.group({tabIds:[live.id],groupId:job.groupId});
        protection.members.push(id);
        delete protection.pending;
        await saveReview(api,job.id,protection);
        if(create||!alreadyOpen)job.created=(job.created||0)+1;else job.reused=(job.reused||0)+1;
        job.firstTabId??=live.id;
        progress();
      });
    }
    summarize();
    if(job.cursor<videoIds.length||ctx.cancelled())return false;
    job.keepProtection=bypass&&protection.members.length>0;job.complete=true;await ctx.checkpoint();
    if(!job.keepProtection){
      await removeReview(api,job.id);
      const live=await getTab(api,marker.id);
      if(reviewToken(api,live?.pendingUrl||live?.url)===job.id)await api.tabs.remove(marker.id);
    }
    if(job.firstTabId){
      const tab=await getTab(api,job.firstTabId);
      if(tab?.groupId===job.groupId&&tab.windowId===job.windowId)await api.tabs.update(tab.id,{active:true});
      await api.windows.update(job.windowId,{focused:true});
    }
    return true;
  });

  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!['review-protection-status','review-protection-stop'].includes(message?.type))return false;
    const id=sender.id===api.runtime.id&&reviewToken(api,sender.url);
    if(!id||!Number.isInteger(sender.tab?.id)||sender.tab.incognito){reply({ok:false});return false}
    runExclusive(async()=>{
      const record=await readReview(api,id);
      if(message.type==='review-protection-status')return {ok:true,active:!!record?.active,bypass:!!record?.bypass,title:record?.title};
      if(record)await removeReview(api,id);
      return {ok:true,active:false};
    },api).then(reply,error=>reply({ok:false,error:error.message}));
    return true;
  });
}
