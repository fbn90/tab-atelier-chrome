import './i18n.js';
import {installInboxReview,previewReview} from './inbox-review.js';
import {assertTabCapacity,assertVideoCapacity} from "./tab-settings.js";
import {createInboxStore,parseInboxBackup,compactInboxItem,INBOX_PREFIX,inboxSelection} from './inbox-store.js';
import {registerInboxJobs,inboxCapturePlan} from './inbox-jobs.js';
import {registerInboxBatch} from './inbox-batch.js';
import {isTrustedPage,validateWindowId} from './extension-pages.js';
import {runExclusive} from './action-coordinator.js';
import {parseYouTubeVideo,parseYouTubeTab,findTabParkerBase,inboxParkedUrl,verifiedInboxParkedRepair,meaningfulYouTubeTitle,meaningfulChannel} from './youtube-url.js';
import {reusableGroupPlan} from './group-reuse.js';
import {createInboxIndex,REVIEW_BATCH_SIZE} from './inbox-model.js';
import {captureFilters} from './inbox-capture-filter.js';

export function installInbox({api,tasks,getMetadata,selectGroup,decorate,enrichMetadata,onMetadataChanged,getLocalMetadata,classificationVersion=()=>0,metadataStatus}) {
  const store=createInboxStore(api.storage.local);
  const compactInbox=()=>store.compactStored().catch(error=>console.warn('Inbox compaction:',error));
  api.runtime.onInstalled?.addListener(compactInbox);
  api.runtime.onStartup?.addListener(compactInbox);
  const index=createInboxIndex(store,decorate,classificationVersion);
  const changed=()=>api.runtime.sendMessage({type:'inbox-changed'}).catch(()=>{});
  const localMetadata=async records=>{
    const cached=getLocalMetadata?await getLocalMetadata(records.map(record=>record.videoId)):new Map();
    const saved=new Map((await store.list()).map(item=>[item.videoId,item]));
    return new Map(records.map(record=>{const old=saved.get(record.videoId),info=cached.get(record.videoId);return [record.videoId,{title:meaningfulYouTubeTitle(info?.title,record.videoId)||old?.title,channel:meaningfulChannel(info?.channel)||meaningfulChannel(old?.channel)}]}));
  };
  registerInboxJobs({api,tasks,store,getMetadata,selectGroup,changed,localMetadata});
  registerInboxBatch({api,tasks,store});
  installInboxReview({api,tasks,store});
  api.storage.onChanged.addListener((changes,area)=>{
    if(area==='local'&&Object.keys(changes).some(key=>key.startsWith(INBOX_PREFIX))) {changed()}
  });
  tasks.register('parked-info-enrich',async(job,ctx)=>{
    if(!job.prepared) {
      const plan=await inboxCapturePlan(api,{...job.payload,parkedOnly:true,includePrivate:false},selectGroup,localMetadata);
      await ctx.write(plan.videos);job.prepared=true;job.cursor=0;job.total=plan.videos.length;job.enriched=0;
    }
    const records=await ctx.read();job.phase=globalThis.atelierI18n.t('ui_parked_info_progress');
    const chunk=records.slice(job.cursor,job.cursor+4);
    if(ctx.cancelled())return false;
    const results=await Promise.all(chunk.map(record=>enrichMetadata(record)));
    for(const [index,record] of chunk.entries()) {
      if(ctx.cancelled())return false;
      const info=results[index];
      const existing=await store.get(record.videoId);
      if(existing)await store.merge([{...existing,...info}],{fillMissing:true,repairTitle:true});
      if(info.channel&&info.channel!=='Unbekannt')job.enriched++;
      job.cursor++;job.processed=job.cursor;
    }
    job.result={ok:true,enriched:job.enriched,total:job.total};changed();onMetadataChanged?.();
    return job.cursor>=records.length;
  });
  async function reviewSelection(message){
    const {filtered,groups}=await index.select(message.filters||{});
    const group=message.groupKey===undefined?null:groups.find(group=>group.key===message.groupKey);
    if(message.groupKey!==undefined&&!group)throw Error(globalThis.atelierI18n.t('reviewSelectionChanged'));
    if(![10,20,'all'].includes(message.amount))throw Error(globalThis.atelierI18n.t('reviewSelectionChanged'));
    const items=group?.items||filtered;
    const videoIds=[...new Set((message.amount==='all'?items:items.slice(0,message.amount)).map(item=>item.videoId))];
    if(!videoIds.length)throw Error(globalThis.atelierI18n.t('reviewSelectionChanged'));
    const search=typeof message.filters?.search==='string'?message.filters.search.trim():'';
    const title=(group?.label||search||'Video-Inbox').slice(0,80);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(videoIds.join(',')));
    const selectionKey=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    return {videoIds,title,selectionKey};
  }
  const handlers={
    'inbox-review-preview':async message=>{
      const {videoIds,title,selectionKey}=await reviewSelection(message);
      return {ok:true,title,selectionKey,...await previewReview(api,videoIds)};
    },
    'inbox-review-start':async (message,sender)=>{
      const {videoIds,title,selectionKey}=await reviewSelection(message);
      if(selectionKey!==message.selectionKey||videoIds.length!==message.count||sender.tab?.incognito||
        !['new','current'].includes(message.target))throw Error(globalThis.atelierI18n.t('reviewSelectionChanged'));
      const windowId=sender.tab?.windowId;
      if(message.target==='current'&&!Number.isInteger(windowId))throw Error(globalThis.atelierI18n.t('reviewWindowChanged'));
      const {needsException}=await previewReview(api,videoIds);
      if(needsException&&message.bypass!==true)throw Error(globalThis.atelierI18n.t('reviewCapacityChanged'));
      return tasks.start('inbox-review-open',{videoIds,title,windowId,target:message.target,bypass:message.bypass===true},
        globalThis.atelierI18n.t('ui_open_inbox_videos_e8f4cd',[videoIds.length]));
    },
    'open-inbox':()=>runExclusive(async()=>{
      const url=api.runtime.getURL('inbox.html');
      const existing=(await api.tabs.query({url})).find(tab=>tab.url===url);
      if(!existing)await assertTabCapacity(api);
      const tab=existing?await api.tabs.update(existing.id,{active:true}):await api.tabs.create({url});
      await api.windows.update(tab.windowId,{focused:true});return {ok:true};
    },api),
    'parked-info-enrich':async message=>{
      if(!enrichMetadata)throw Error('Metadata unavailable');
      if(message.includePrivate)throw Error(globalThis.atelierI18n.t('ui_parked_info_no_private'));
      const filters=captureFilters(message);validateWindowId(message.windowId);
      return tasks.start('parked-info-enrich',{...filters,windowId:message.windowId},globalThis.atelierI18n.t('ui_parked_info_action'));
    },
    'inbox-metadata-status':async()=>({ok:true,...await metadataStatus()}),
    'inbox-query':async message=>({ok:true,...await index.page(message)}),
    'inbox-set-topic':message=>runExclusive(async()=>{
      if(typeof message.topic!=='string'||message.topic.length>120)throw Error(globalThis.atelierI18n.t('inboxTopicInvalid'));
      await store.setTopic(message.videoId,message.topic.trim());changed();onMetadataChanged?.();return {ok:true};
    },api),
    'inbox-set-filtered-status':message=>runExclusive(async()=>{
      const {filtered}=await index.select({...message,status:message.matchStatus});
      const ids=filtered.map(item=>item.videoId);
      if(!ids.length)return {ok:true,count:0};
      for(let start=0;start<ids.length;start+=500){
        const stamp=index.version(), batch=ids.slice(start,start+500);
        await store.setStatuses(batch,message.status);
        index.updateStatuses(stamp,batch,message.status);
      }
      changed();return {ok:true,count:ids.length};
    },api),
    'inbox-list':async()=>({ok:true,items:await decorate(await store.list())}),
    'inbox-preview':async message=>{
      const plan=await inboxCapturePlan(api,message,selectGroup,localMetadata);
      return {ok:true,tabCount:plan.tabs.length,videoCount:plan.videos.length,
        videos:plan.videos.slice(0,5).map(record=>({videoId:record.videoId,title:record.tabTitle,parked:record.parked}))};
    },
    'inbox-capture':async message=>{
      if(message.closeTabs!==undefined&&typeof message.closeTabs!=='boolean')throw Error(globalThis.atelierI18n.t("ui_invalid_option_for_closing_tabs_6a2920"));
      const filters=captureFilters(message);
      // The worker freezes the actual selection when the job starts, before the first write.
      return tasks.start('inbox-capture',{windowId:message.windowId,closeTabs:message.closeTabs!==false,
        includePrivate:message.includePrivate===true,groupBy:message.groupBy,groupKey:message.groupKey,...filters},globalThis.atelierI18n.t("ui_save_videos_to_inbox_a96fb0"));
    },
    'inbox-set-status':message=>runExclusive(async()=>{
      const stamp=index.version();
      const item=await store.setStatus(message.videoId,message.status);index.updateStatuses(stamp,[item.videoId],item.status);changed();return {ok:true,item};
    },api),
    'inbox-set-status-batch':message=>runExclusive(async()=>{
      const result=await store.setStatuses(message.videoIds,message.status);changed();return {ok:true,...result};
    },api),
    'inbox-open-batch':async(message,sender)=>{
      const videoIds=inboxSelection(message.videoIds).slice(0,REVIEW_BATCH_SIZE),target=message.target||'new';
      if(!['new','current'].includes(target))throw Error(globalThis.atelierI18n.t("ui_invalid_destination_window_3c5bc5"));
      const windowId=sender.tab?.windowId??message.windowId;
      if(target==='current'&&(!Number.isInteger(windowId)||windowId<0||sender.tab?.incognito))throw Error(globalThis.atelierI18n.t("ui_please_open_the_inbox_in_a_regular_browser_window_7b131e"));
      const title=typeof message.title==='string'?message.title.trim().slice(0,100):'';
      return tasks.start('inbox-open-batch',{videoIds,target,windowId,title:title||'Video-Inbox',groupMode:message.groupMode==='topic'?'topic':'channel'},globalThis.atelierI18n.t("ui_open_inbox_videos_e8f4cd", [videoIds.length]));
    },
    'inbox-open':async message=>{
      const saved=await store.get(message.videoId);if(!saved)throw Error(globalThis.atelierI18n.t("ui_video_not_in_the_inbox_e458e2"));
      if(saved.channel&&saved.channel!=='Unbekannt') {
        const plan=await reusableGroupPlan(api,saved.channel,{contexts:[false]});
        if(plan.targets.false)return tasks.start('inbox-open-batch',{videoIds:[saved.videoId],target:'new',title:saved.channel},globalThis.atelierI18n.t("ui_open_video_in_existing_channel_group_928af5"));
      }
      return runExclusive(async()=>{
      const item=await store.get(message.videoId);if(!item)throw Error(globalThis.atelierI18n.t("ui_video_not_in_the_inbox_e458e2"));
      if(parseYouTubeVideo(item.openUrl)?.videoId!==item.videoId)throw Error(globalThis.atelierI18n.t("ui_invalid_saved_link_1ae2b3"));
      const inventory=await api.tabs.query({});
      const parkerBase=await findTabParkerBase(api,inventory);
      let existing=inventory.find(tab=>!tab.incognito&&parseYouTubeTab(tab.pendingUrl||tab.url)?.videoId===item.videoId);
      if(existing){
        const live=await api.tabs.get(existing.id).catch(()=>null);
        existing=live&&!live.incognito&&parseYouTubeTab(live.pendingUrl||live.url)?.videoId===item.videoId?live:null;
      }
      if(!existing)await assertVideoCapacity(api,inventory,inventory.filter(tab=>!tab.incognito&&parseYouTubeTab(tab.pendingUrl||tab.url)).length);
      const repair=await verifiedInboxParkedRepair(api,existing,item.title);
      if(repair){
        const checked=await api.tabs.get(existing.id).catch(()=>null);
        if(!checked||checked.url!==existing.url||checked.windowId!==existing.windowId||checked.pendingUrl||checked.status==='loading')return {ok:true,skipped:1};
      }
      const tab=existing?await api.tabs.update(existing.id,{active:true,...(repair?{url:repair}:{})}):
        await api.tabs.create({url:inboxParkedUrl(parkerBase,item.openUrl,item.title,item.channel)});
      await api.windows.update(tab.windowId,{focused:true});return {ok:true};
      },api);
    },
    'inbox-export':async()=>({ok:true,backup:{format:'tab-atelier-inbox',version:2,exportedAt:new Date().toISOString(),items:(await store.list()).map(compactInboxItem)}}),
    'inbox-restore':async message=>{
      if(JSON.stringify(message.backup).length>6_000_000)throw Error(globalThis.atelierI18n.t("ui_backup_too_large_maximum_6_mb_515e64"));
      return tasks.start('inbox-restore',{items:parseInboxBackup(message.backup)},globalThis.atelierI18n.t("ui_import_inbox_backup_f6bf3e"));
    }
  };
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!Object.hasOwn(handlers,message?.type))return false;
    if(!isTrustedPage(sender,api)){reply({ok:false,error:globalThis.atelierI18n.t("ui_unauthorized_message_source_674efb")});return false;}
    Promise.resolve().then(()=>handlers[message.type](message,sender)).then(reply,error=>reply({ok:false,error:error.message||globalThis.atelierI18n.t("ui_inbox_action_failed_54b600")}));return true;
  });
  return store;
}
