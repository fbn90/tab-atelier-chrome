import './i18n.js';
import {parseYouTubeTab,discoverTabParkers,meaningfulYouTubeTitle,canCloseYouTubeSource} from './youtube-url.js';
import {validateWindowId} from './extension-pages.js';
import {captureFilters,captureTabTitle,matchesCaptureFilters} from './inbox-capture-filter.js';

export async function inboxCapturePlan(api,payload={},selectGroup,localMetadata) {
  validateWindowId(payload.windowId);
  const filters=captureFilters(payload);
  if(payload.closeTabs!==undefined&&typeof payload.closeTabs!=='boolean')throw Error(globalThis.atelierI18n.t("ui_invalid_option_for_closing_tabs_6a2920"));
  if(payload.includePrivate!==undefined&&typeof payload.includePrivate!=='boolean')throw Error(globalThis.atelierI18n.t("ui_invalid_private_tab_selection_c0260f"));
  let allowed=null;
  if(payload.groupKey!==undefined) {
    if(!['channel','topic'].includes(payload.groupBy)||typeof payload.groupKey!=='string')throw Error(globalThis.atelierI18n.t("ui_invalid_group_5527a3"));
    allowed=new Set(await selectGroup(payload.groupBy,payload.groupKey));
  }
  const tabs=[],videos=new Map(), snapshot=await api.tabs.query({});
  await discoverTabParkers(api,snapshot);
  const local=localMetadata?await localMetadata(snapshot.map(tab=>({...parseYouTubeTab(tab.url),incognito:!!tab.incognito})).filter(item=>item.parked&&!item.incognito)):new Map();
  for(const tab of snapshot) {
    if(tab.incognito&&!payload.includePrivate || payload.windowId!==undefined&&tab.windowId!==payload.windowId || allowed&&!allowed.has(tab.id))continue;
    // Navigation in progress cannot become a close candidate.
    if(tab.pendingUrl)continue;
    const parsed=parseYouTubeTab(tab.url);if(!parsed || parsed.sourceUrl.length>4096)continue;
    const info=tab.incognito?{}:local.get(parsed.videoId)||{};
    const tabTitle=captureTabTitle(tab,parsed,info);
    // Filter each source tab before consolidating video IDs. An unrelated
    // duplicate must never become a close candidate through a matching copy.
    if(!matchesCaptureFilters(tabTitle,parsed.parked,filters))continue;
    const record={tabId:tab.id,videoId:parsed.videoId,url:parsed.canonicalUrl,sourceUrl:parsed.sourceUrl,
      originalUrl:tab.url,parked:parsed.parked,tabChannel:parsed.channel||info.channel,windowId:tab.windowId,
      incognito:!!tab.incognito,pinned:!!tab.pinned,status:tab.status,discarded:!!tab.discarded,tabTitle};
    tabs.push(record);
    const existing=videos.get(record.videoId);
    if(!existing)videos.set(record.videoId,{...record,sourceUrls:[record.sourceUrl]});
    else {
      if(!existing.sourceUrls.includes(record.sourceUrl)&&existing.sourceUrls.length<16)existing.sourceUrls.push(record.sourceUrl);
      if(existing.parked&&!record.parked || existing.parked===record.parked&&existing.discarded&&!record.discarded)
        Object.assign(existing,{...record,sourceUrls:existing.sourceUrls});
    }
  }
  return {tabs,videos:[...videos.values()]};
}
export function registerInboxJobs({api,tasks,store,getMetadata,selectGroup,changed,localMetadata}) {
  tasks.register('inbox-restore',async(job,ctx)=>{
    const items=job.payload.items;job.total=items.length;job.phase=globalThis.atelierI18n.t("ui_import_backup_1da417");
    await store.merge(items.slice(job.cursor,job.cursor+100),{restore:true});
    job.cursor=Math.min(items.length,job.cursor+100);job.processed=job.cursor;
    job.result={ok:true,inboxSaved:job.cursor};changed();
    const done=job.cursor>=items.length;if(done)delete job.payload.items;return done;
  });
  tasks.register('inbox-capture',async(job,ctx)=>{
    if(!job.prepared) {
      const plan=await inboxCapturePlan(api,job.payload,selectGroup,localMetadata);
      await ctx.write(plan);job.prepared=true;job.stage='save';job.cursor=0;job.total=plan.videos.length;job.closed=0;job.skipped=0;job.incomplete=0;
    }
    const plan=await ctx.read();
    const summarize=()=>{job.result={ok:true,inboxSaved:job.saved||0,matchedTabs:plan.tabs.length,closedTabs:job.closed,skipped:job.skipped,metadataIncomplete:job.incomplete}};
    if(job.stage==='save') {
      job.phase=globalThis.atelierI18n.t("ui_safely_saving_titles_and_links_7bb4ca");
      const selected=plan.videos.slice(job.cursor,job.cursor+100);
      await store.merge(selected.map(record=>({videoId:record.videoId,url:record.url,openUrl:record.sourceUrl||record.originalUrl,
        sourceUrls:record.sourceUrls,title:record.tabTitle,channel:record.tabChannel||'Unbekannt',metadataComplete:false,metadataPrivate:record.incognito})));
      job.cursor+=selected.length;job.saved=job.cursor;job.processed=job.cursor;summarize();changed();
      if(job.cursor<plan.videos.length)return false;
      job.stage='metadata';job.cursor=0;job.processed=0;await ctx.checkpoint();return false;
    }
    if(job.stage==='metadata') {
      job.phase=globalThis.atelierI18n.t("ui_adding_channels_and_titles_a8166b");job.total=plan.videos.length;
      const selected=plan.videos.slice(job.cursor,job.cursor+4);
      const items=await Promise.all(selected.map(async record=>{
        let metadata;try{metadata=await getMetadata(record)}catch{metadata={}}
        const localTitle=meaningfulYouTubeTitle(record.tabTitle,record.videoId);
        const resolvedTitle=meaningfulYouTubeTitle(metadata?.title,record.videoId);
        const title=(record.parked?localTitle||resolvedTitle:resolvedTitle||localTitle)||record.tabTitle;
        return {videoId:record.videoId,url:record.url,openUrl:record.sourceUrl||record.originalUrl,sourceUrls:record.sourceUrls,
          title,metadataPrivate:record.incognito,channel:record.tabChannel||metadata?.channel||'Unbekannt',
          metadataComplete:!!meaningfulYouTubeTitle(title,record.videoId)&&!!metadata?.channel&&metadata.channel!=='Unbekannt'};
      }));
      const stored=await store.merge(items,{metadata:true,existingOnly:true});
      job.incomplete+=stored.filter(item=>!item.metadataComplete).length;
      job.cursor+=selected.length;job.processed=job.cursor;summarize();changed();
      if(job.cursor<plan.videos.length)return false;
      job.stage=job.payload.closeTabs?'close':'done';job.cursor=0;job.processed=0;await ctx.checkpoint();
    }
    if(job.stage==='close') {
      job.phase=globalThis.atelierI18n.t("ui_closing_saved_tabs_972dca");job.total=plan.tabs.length;
      const filters=captureFilters(job.payload);
      for(const record of plan.tabs.slice(job.cursor,job.cursor+20)) {
        if(ctx.cancelled())return false;
        const isSame=tab=>{
          if(!tab||tab.pendingUrl||tab.status==='loading'||tab.url!==record.originalUrl||
              tab.windowId!==record.windowId||!!tab.incognito!==record.incognito||!!tab.pinned!==record.pinned)return false;
          if(!canCloseYouTubeSource(tab.url))return false;
          const parsed=parseYouTubeTab(tab.url);
          return !!parsed&&matchesCaptureFilters(captureTabTitle(tab,parsed,record),parsed.parked,filters);
        };
        let live;try{live=await api.tabs.get(record.tabId)}catch{}
        if(!isSame(live)){job.skipped++;job.cursor++;continue;}
        await ctx.effect(async()=>{
          // Read durable local storage again immediately before closing. A cache entry is not a receipt.
          const saved=await store.get(record.videoId);
          if(!saved || saved.videoId!==record.videoId || saved.url!==record.url || !Array.isArray(saved.sourceUrls))throw Error(globalThis.atelierI18n.t("ui_the_saved_link_could_not_be_verified_the_tab_will_st_d18651"));
          if(!saved.sourceUrls.includes(record.sourceUrl||record.originalUrl)){job.skipped++;job.cursor++;job.processed=job.cursor;summarize();return;}
          try{live=await api.tabs.get(record.tabId)}catch{live=null}
          if(ctx.cancelled())return;
          if(isSame(live)){await api.tabs.remove(record.tabId);job.closed++}else job.skipped++;
          job.cursor++;job.processed=job.cursor;summarize();
        });
      }
      job.processed=job.cursor;summarize();
      if(job.cursor<plan.tabs.length)return false;
      job.stage='done';
    }
    summarize();job.phase=globalThis.atelierI18n.t("ui_saved_to_the_inbox_5d970d");changed();return true;
  });
}
