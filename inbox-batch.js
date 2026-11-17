import './i18n.js';
import {REVIEW_BATCH_SIZE} from './inbox-model.js';
import {videoCapacityWarning} from "./tab-settings.js";
import {inboxSelection,normalizeInboxItem} from './inbox-store.js';
import {parseYouTubeTab,findTabParkerBase,inboxParkedUrl,verifiedInboxParkedRepair} from './youtube-url.js';
import {groupNameKey,reusableGroupPlan} from './group-reuse.js';
import {transferStep} from './tab-transfer.js';

const videoId=tab=>!tab?.incognito&&parseYouTubeTab(tab?.pendingUrl||tab?.url)?.videoId;
async function normalWindow(api,id) {
  let window;try{window=await api.windows.get(id)}catch{}
  if(!window||window.incognito||window.type!=='normal')throw Error(globalThis.atelierI18n.t("ui_the_destination_window_is_no_longer_available_tabs_a_838988"));
  return window;
}

export function registerInboxBatch({api,tasks,store}) {
  tasks.register('inbox-open-batch',async(job,ctx)=>{
    if(!job.prepared) {
      const ids=inboxSelection(job.payload.videoIds).slice(0,REVIEW_BATCH_SIZE),saved=new Map((await store.list()).map(item=>[item.videoId,item]));
      const records=ids.map(id=>{
        const item=saved.get(id);if(!item)throw Error(globalThis.atelierI18n.t("ui_a_selected_video_is_no_longer_in_the_inbox_please_re_710771"));
        const valid=normalizeInboxItem(item);
        return {videoId:id,url:valid.openUrl,title:valid.title,channel:valid.channel};
      });
      const channels=new Map(ids.map(id=>saved.get(id).channel).filter(channel=>channel&&channel!=='Unbekannt').map(channel=>[groupNameKey(channel),channel]));
      const allKnown=ids.every(id=>saved.get(id).channel&&saved.get(id).channel!=='Unbekannt');
      job.groupTitle=job.payload.groupMode!=='topic'&&allKnown&&channels.size===1?[...channels.values()][0]:job.payload.title;
      const plan=await reusableGroupPlan(api,job.groupTitle,{contexts:[false]});
      if(plan.targets.false) {
        job.mergeTask={type:'move-group-to-window',label:job.groupTitle,cursor:0,processed:0,total:plan.records.length};
        await ctx.write(plan,'mergePlan');
      }
      job.total=records.length;job.created=0;job.reused=0;job.grouped=0;job.skipped=0;
      if(job.payload.target==='current') {
        await normalWindow(api,job.payload.windowId);job.windowId=job.payload.windowId;
      }
      await ctx.write(records);job.prepared=true;await ctx.checkpoint();return false;
    }
    if(job.mergeTask&&!job.mergeDone) {
      job.phase=globalThis.atelierI18n.t("ui_merging_existing_groups_with_the_same_name_814a0a");
      const mergeCtx={...ctx,write:(value,name='data')=>ctx.write(value,'merge-'+name),read:(name='data')=>ctx.read('merge-'+name)};
      const done=await transferStep(job.mergeTask,mergeCtx,(await mergeCtx.read())||[],{api,groupTitle:job.groupTitle,reuseGroups:true,
        reusePlan:await ctx.read('mergePlan'),contexts:[false],matches:(tab,record)=>tab.url===record.url&&!tab.pendingUrl&&tab.status!=='loading'});
      job.mergeTask.errors??=[];
      job.errors=job.mergeTask.errors;job.processed=job.mergeTask.processed;job.total=job.mergeTask.total;
      job.phase=globalThis.atelierI18n.t("ui_existing_groups_8653ef", [job.mergeTask.phase]);
      if(!done)return false;
      if(job.mergeTask.result.warningCount)throw Error(globalThis.atelierI18n.t("ui_existing_groups_could_not_be_fully_merged_see_the_ta_858cbb"));
      job.windowId=job.mergeTask.transfer.destinations.false;
      job.groupId=job.mergeTask.transfer.groups[job.windowId];
      if(job.groupId===undefined)throw Error(globalThis.atelierI18n.t("ui_the_destination_group_is_no_longer_available_please_bfd4e0"));
      job.mergeDone=true;job.processed=0;job.total=(await ctx.read()).length;await ctx.checkpoint();return false;
    }
    const records=(await ctx.read())?.slice(0,REVIEW_BATCH_SIZE);
    if(!records)throw Error(globalThis.atelierI18n.t("ui_the_saved_selection_is_missing_please_restart_the_ac_8f8877"));
    job.total=records.length;
    const summarize=()=>{job.result={ok:true,createdTabs:job.created,reusedTabs:job.reused,groupedTabs:job.grouped,skipped:job.skipped+(job.mergeTask?.result?.skipped||0),windowId:job.windowId,groupId:job.groupId,
      limitSkipped:job.limitSkipped||0,groupReused:!!job.mergeDone,duplicatesClosed:job.mergeTask?.result?.duplicatesClosed||0}};
    const checkGroup=async()=>{
      if(job.groupId===undefined)return;
      let group;try{group=await api.tabGroups.get(job.groupId)}catch{}
      if(!group||group.windowId!==job.windowId||groupNameKey(group.title)!==groupNameKey(job.groupTitle))throw Error(globalThis.atelierI18n.t("ui_the_tab_group_was_closed_renamed_or_moved_tabs_alrea_edb847"));
    };
    job.phase=globalThis.atelierI18n.t("ui_opening_videos_and_collecting_them_in_one_group_4bb35c");
    if(job.windowId!==undefined)await normalWindow(api,job.windowId);
    // One inventory per small step; never one full-browser query per video.
    const candidates=new Map(),inventory=await api.tabs.query({windowType:'normal'});
    const parkerBase=await findTabParkerBase(api,inventory);
    for(const tab of inventory) {
      const id=videoId(tab);if(!id)continue;
      const old=candidates.get(id);
      const priority=t=>(t.groupId===job.groupId?4:0)+(t.windowId===job.windowId?2:0)+(!t.pinned?1:0);
      if(!old||priority(tab)>priority(old))candidates.set(id,tab);
    }
    for(const record of records.slice(job.cursor,job.cursor+5)) {
      if(ctx.cancelled())return false;
      await ctx.effect(async()=>{
        if(job.windowId!==undefined)await normalWindow(api,job.windowId);
        await checkGroup();
        if(ctx.cancelled())return;
        let tab=candidates.get(record.videoId);const existing=!!tab;
        if(tab) {
          let live;try{live=await api.tabs.get(tab.id)}catch{}
          // A user's navigation or move takes precedence over our frozen plan.
          if(videoId(live)!==record.videoId||live.windowId!==tab.windowId) {
            job.skipped++;job.cursor++;job.processed=job.cursor;summarize();return;
          }
          tab=live;
          const source=await api.windows.get(tab.windowId);
          if(source.type!=='normal'||source.incognito)throw Error(globalThis.atelierI18n.t("ui_the_existing_video_tab_cannot_be_moved_into_a_regula_7db004"));
          try{live=await api.tabs.get(tab.id)}catch{live=null}
          if(videoId(live)!==record.videoId||live.windowId!==tab.windowId) {
            job.skipped++;job.cursor++;job.processed=job.cursor;summarize();return;
          }
          tab=live;
        }
        if(ctx.cancelled())return;
        if(!tab) {
          const live=await api.tabs.query({});
          if(await videoCapacityWarning(api,live,live.filter(videoId).length)){
            job.limitSkipped=(job.limitSkipped||0)+1;
            job.cursor++;job.processed=job.cursor;summarize();return;
          }
        }
        const title=record.title||(await store.get(record.videoId))?.title;
        const openUrl=inboxParkedUrl(parkerBase,record.url,title,record.channel);
        if(tab){
          const repaired=await verifiedInboxParkedRepair(api,tab,title);
          if(repaired){
            const checked=await api.tabs.get(tab.id).catch(()=>null);
            if(!checked||checked.url!==tab.url||checked.windowId!==tab.windowId||checked.pendingUrl||checked.status==='loading'){job.skipped++;job.cursor++;job.processed=job.cursor;summarize();return}
            tab=await api.tabs.update(tab.id,{url:repaired});
          }
        }
        if(job.windowId===undefined) {
          // Seed with the actual video tab; no placeholder tab or URL reopening.
          const target=await api.windows.create({...(tab?{tabId:tab.id}:{url:openUrl}),type:'normal',incognito:false,focused:false});
          if(!Number.isInteger(target?.id))throw Error(globalThis.atelierI18n.t("ui_could_not_verify_the_new_window_please_check_the_ope_7312c2"));
          job.windowId=target.id;
          if(tab)tab=await api.tabs.get(tab.id);
          else tab=target.tabs?.find(t=>videoId(t)===record.videoId)||(await api.tabs.query({windowId:target.id})).find(t=>videoId(t)===record.videoId);
          if(!tab)throw Error(globalThis.atelierI18n.t("ui_could_not_verify_the_new_video_tab_please_check_the_baf11f"));
        } else if(tab) {
          if(tab.windowId!==job.windowId)tab=await api.tabs.move(tab.id,{windowId:job.windowId,index:-1});
        } else tab=await api.tabs.create({windowId:job.windowId,url:openUrl,active:false});
        if(existing)job.reused++;else job.created++;
        summarize();await ctx.checkpoint();
        if(ctx.cancelled())return;
        await normalWindow(api,job.windowId);
        let live=await api.tabs.get(tab.id);
        if(videoId(live)!==record.videoId||live.windowId!==job.windowId) {
          job.skipped++;job.cursor++;job.processed=job.cursor;summarize();return;
        }
        // Pinned tabs cannot belong to a group. This is disclosed beside the action.
        if(live.pinned) {
          await api.tabs.update(live.id,{pinned:false});
          live=await api.tabs.get(live.id);
          if(videoId(live)!==record.videoId||live.windowId!==job.windowId)throw Error(globalThis.atelierI18n.t("ui_a_video_tab_changed_during_grouping_please_open_the_db0bfb"));
        }
        if(ctx.cancelled())return;
        if(job.groupId===undefined) {
          job.groupId=await api.tabs.group({tabIds:[live.id],createProperties:{windowId:job.windowId}});
          summarize();await ctx.checkpoint();
          await api.tabGroups.update(job.groupId,{title:job.groupTitle,color:'green',collapsed:false});
        } else {
          await checkGroup();
          live=await api.tabs.get(live.id);
          if(videoId(live)!==record.videoId||live.windowId!==job.windowId)throw Error(globalThis.atelierI18n.t("ui_a_video_tab_changed_during_grouping_please_open_the_db0bfb"));
          await api.tabs.group({tabIds:[live.id],groupId:job.groupId});
        }
        const grouped=await api.tabs.get(live.id);
        if(videoId(grouped)!==record.videoId||grouped.windowId!==job.windowId||grouped.groupId!==job.groupId)
          throw Error(globalThis.atelierI18n.t('inboxOpenUnconfirmed'));
        await store.removeOpened(record.videoId);
        if(job.firstTabId===undefined){job.firstTabId=live.id;job.firstVideoId=record.videoId}
        job.grouped++;job.cursor++;job.processed=job.cursor;summarize();
      });
    }
    summarize();
    if(job.cursor<records.length)return false;
    // Focus only once, when the batch is ready. Never reopen a removed tab.
    if(!ctx.cancelled()&&job.firstTabId!==undefined)await ctx.effect(async()=>{
      let tab;try{tab=await api.tabs.get(job.firstTabId)}catch{}
      if(tab?.windowId===job.windowId&&tab.groupId===job.groupId&&videoId(tab)===job.firstVideoId) {
        await api.tabs.update(tab.id,{active:true});await api.windows.update(job.windowId,{focused:true});
      }
    });
    job.phase=globalThis.atelierI18n.t("ui_videos_opened_in_one_tab_group_d9e04e");return !ctx.cancelled();
  });
}
