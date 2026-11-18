import './i18n.js';
import {groupNameKey,reusableGroupPlan} from './group-reuse.js';
import {parseYouTubeTab as parseYouTubeVideo, canCloseYouTubeSource} from './youtube-url.js';
// Checkpointed moves of existing tabs. Optional named-group merging only closes
// confirmed duplicate videos in the destination; it never reopens URLs.
export function resumableTransfer(job) {
  return ['domain-window','move-group-to-window','automatic-window-limit','automatic-domain-routing','manual-domain-routing'].includes(job.type) && job.transfer?.version === 1;
}

export async function transferStep(job, ctx, records, {api=chrome, matches, groupTitle=null, onMoved=async()=>{},reuseGroups=false,reusePlan=null,contexts=null,sourceWindowId,maxTabsPerWindow=null,destinationMatches=()=>true,destinationKey=tab=>String(!!tab.incognito),initialDestinations={},countsTowardLimit=()=>true,groupForRecord=null}={}) {
  if(maxTabsPerWindow!==null&&(!Number.isInteger(maxTabsPerWindow)||maxTabsPerWindow<1))throw Error(globalThis.atelierI18n.t("ui_invalid_maximum_tab_count_per_window_4de0c8"));
  if (!job.transfer) {
    if (job.cursor) throw Error(globalThis.atelierI18n.t("ui_this_older_task_cannot_be_resumed_safely_please_sele_1f4474"));
    job.transfer={version:1,stage:'move',destinations:{...initialDestinations},arrived:[],pending:null,pinCursor:0,groupCursor:0,groups:{},grouped:0,windowsCreated:0,warningCount:0,maxTabsPerWindow};
    await ctx.checkpoint();
  }
  const state=job.transfer;
  if(state.maxTabsPerWindow===undefined){state.maxTabsPerWindow=maxTabsPerWindow;await ctx.checkpoint()}
  if(reuseGroups&&!state.reusePrepared) {
    const plan=reusePlan||await reusableGroupPlan(api,groupTitle,{contexts:contexts||[...new Set(records.map(record=>!!record.incognito))],sourceWindowId});
    state.reusedGroups=[];state.duplicatesClosed=0;
    for(const [context,target] of Object.entries(plan.targets)) {
      state.destinations[context]=target.windowId;state.groups[target.windowId]=target.groupId;state.reusedGroups.push(target.groupId);
    }
    const members=new Map(plan.records.map(record=>[record.tabId,record])),seen=new Set();
    records=records.map(record=>{const id=record.tabId??record.id;seen.add(id);return members.has(id)?{...record,sourceGroupId:members.get(id).sourceGroupId}:record});
    records.push(...plan.records.filter(record=>!seen.has(record.tabId)));
    job.total=records.length;await ctx.write(records);state.reusePrepared=true;await ctx.checkpoint();
  }
  const matchesRecord=(tab,record)=>record.reuseMember?
    !tab.pendingUrl&&tab.status!=='loading'&&tab.url===record.url&&!!tab.incognito===!!record.incognito:matches(tab,record);
  const idOf=record=>record.tabId??record.id;
  const getTab=async id=>{try{return await api.tabs.get(id)}catch{return null}};
  const getWindow=async(id,incognito)=>{
    if(!Number.isInteger(id))return null;
    try {const win=await api.windows.get(id);return win.type==='normal' && !!win.incognito===!!incognito?win:null}catch{return null}
  };
  const hasRoom=async(id,tab)=>{
    if(!await getWindow(id,tab.incognito))return false;
    if(state.maxTabsPerWindow===null)return true;
    const members=await api.tabs.query({windowId:id});
    return (!countsTowardLimit(tab)||members.filter(member=>member.id!==tab.id&&countsTowardLimit(member)).length<state.maxTabsPerWindow)&&members.every(member=>destinationMatches(member,tab));
  };
  const warn=(stage,tabId,message)=>{
    state.warningCount++;
    job.errors??=[];
    job.errors.push({stage,tabId,message});
    if(job.errors.length>20)job.errors.shift();
  };
  const summarize=()=>{
    job.count=state.arrived.length;
    job.result={ok:true,label:job.label,count:job.count,movedTabs:job.count,groupedTabs:state.grouped,
      groupCreated:state.grouped>0,windowsCreated:state.windowsCreated,
      skipped:job.cursor-job.count,warningCount:state.warningCount,duplicatesClosed:state.duplicatesClosed||0,reusedGroups:state.reusedGroups?.length||0};
  };
  const arrived=(record,tab,pending)=>{
    state.arrived.push({id:tab.id,recordIndex:job.cursor,windowId:tab.windowId,pinned:pending.pinned});
    state.destinations[destinationKey(tab)]=tab.windowId;
    state.pending=null;job.cursor++;job.processed=job.cursor;summarize();
  };
  const skip=()=>{state.pending=null;job.cursor++;job.processed=job.cursor;summarize()};
  async function reconcile(record) {
    const pending=state.pending;
    if(!pending)return false;
    const tab=await getTab(pending.tabId);
    if(!tab || !matchesRecord(tab,record)) {skip();await ctx.checkpoint();return true;}
    if(tab.windowId===pending.sourceWindowId)return false;
    // For a create whose response was lost, accept only the new, single-tab
    // window containing this exact tab. Never pull tabs back from arbitrary windows.
    let confirmed=tab.windowId===pending.destinationId;
    if(pending.destinationId===null && await getWindow(tab.windowId,tab.incognito)) {
      const members=await api.tabs.query({windowId:tab.windowId});
      confirmed=members.length===1 && members[0].id===tab.id;
      if(confirmed)state.windowsCreated++;
    }
    if(confirmed) {arrived(record,tab,pending);await onMoved(tab.id);}
    else {warn('move',tab.id,globalThis.atelierI18n.t("ui_tab_was_moved_to_another_window_and_will_be_left_the_575823"));skip();}
    await ctx.checkpoint();return true;
  }
  // Validate targets before each chunk, and again before every browser mutation.
  for(const [context,id] of Object.entries(state.destinations)) {
    if(!await getWindow(id,context==='true'||context.startsWith('true|'))) {
      delete state.destinations[context];
      warn('move',null,globalThis.atelierI18n.t("ui_the_destination_window_no_longer_exists_remaining_ta_e565fa"));
    }
  }
  if(state.stage==='move') {
    job.phase=globalThis.atelierI18n.t("ui_moving_tabs_f721b2");
    const end=Math.min(records.length,job.cursor+10);
    while(job.cursor<end && !ctx.cancelled()) {
      const record=records[job.cursor];
      if(await reconcile(record))continue;
      let tab=await getTab(idOf(record));
      const source=state.pending?.sourceWindowId??record.windowId;
      if(!tab || !matchesRecord(tab,record) || (source!==undefined && tab.windowId!==source)) {skip();continue;}
      const context=destinationKey(tab);
      let target=state.destinations[context];
      if(!await hasRoom(target,tab)) {delete state.destinations[context];target=undefined;}
      state.pending={tabId:tab.id,sourceWindowId:tab.windowId,destinationId:target??null,pinned:!!tab.pinned};
      await ctx.effect(async()=>{
        tab=await getTab(idOf(record));
        if(!tab || !matchesRecord(tab,record) || tab.windowId!==state.pending.sourceWindowId) {skip();return;}
        if(record.sourceGroupId!==undefined) {
          let sourceGroup;try{sourceGroup=await api.tabGroups.get(record.sourceGroupId)}catch{}
          if(tab.groupId!==record.sourceGroupId||!sourceGroup||groupNameKey(sourceGroup.title)!==groupNameKey(groupTitle)) {
            warn('move',tab.id,globalThis.atelierI18n.t("ui_the_tab_or_source_group_changed_and_will_remain_wher_d72bed"));skip();return;
          }
        }
        const existingGroup=target===undefined?undefined:state.groups[target];
        if(state.reusedGroups?.includes(existingGroup)) {
          let group;try{group=await api.tabGroups.get(existingGroup)}catch{}
          if(group&&(group.windowId!==target||groupNameKey(group.title)!==groupNameKey(groupTitle)))throw Error(globalThis.atelierI18n.t("ui_the_destination_group_changed_please_restart_the_act_8ff210"));
        }
        if(target!==undefined && !await getWindow(target,tab.incognito)) {
          delete state.destinations[context];state.pending=null;return;
        }
        tab=await getTab(idOf(record));
        if(!tab||!matchesRecord(tab,record)||tab.windowId!==state.pending.sourceWindowId||!!tab.pinned!==state.pending.pinned||
          record.sourceGroupId!==undefined&&tab.groupId!==record.sourceGroupId) {skip();return;}
        // Count actual members again after intent persistence: pinned and manually
        // added tabs also consume capacity. Never move an eleventh tab into a target.
        if(target!==undefined&&!await hasRoom(target,tab)){
          delete state.destinations[context];target=undefined;state.pending.destinationId=null;
          await ctx.checkpoint();
          tab=await getTab(idOf(record));
          if(!tab||!matchesRecord(tab,record)||tab.windowId!==state.pending.sourceWindowId||!!tab.pinned!==state.pending.pinned){skip();return}
        }
        try {
          if(target===undefined) {
            const created=await api.windows.create({tabId:tab.id,incognito:!!tab.incognito,focused:false,type:'normal'});
            if(!Number.isInteger(created?.id))throw Error(globalThis.atelierI18n.t("ui_chrome_did_not_return_a_destination_window_3cd1f9"));
            target=created.id;state.pending.destinationId=target;state.destinations[context]=target;state.windowsCreated++;
          } else if(tab.windowId!==target||!reuseGroups)await api.tabs.move(tab.id,{windowId:target,index:-1});
          const live=await getTab(tab.id);
          if(!live || live.windowId!==target)throw Error(globalThis.atelierI18n.t("ui_the_tab_did_not_arrive_in_the_destination_window_d082f8"));
          arrived(record,live,state.pending);
          // Save the successful move before pinning or grouping can fail.
          await ctx.checkpoint();await onMoved(live.id);
        } catch(error) {
          if(await reconcile(record))return;
          if(target!==undefined && !await getWindow(target,tab.incognito)) {
            delete state.destinations[context];state.pending=null;
            warn('move',tab.id,globalThis.atelierI18n.t("ui_the_destination_window_was_closed_during_the_move_57e13c"));
            return;
          }
          throw Error(globalThis.atelierI18n.t("ui_move_interrupted_tabs_already_moved_are_kept_resume_2c182d", [error.message]));
        }
      });
      // Yield if the target disappeared between checking and using it.
      if(state.pending===null && job.cursor<end && idOf(records[job.cursor])===idOf(record))break;
    }
    summarize();
    if(job.cursor<records.length || ctx.cancelled())return false;
    state.stage='pin';job.processed=0;job.total=state.arrived.length;
    await ctx.checkpoint();return false;
  }
  if(state.stage==='pin') {
    job.phase=globalThis.atelierI18n.t("ui_checking_pinned_tabs_31ca2a");
    const end=Math.min(state.arrived.length,state.pinCursor+10);
    while(state.pinCursor<end && !ctx.cancelled()) {
      const item=state.arrived[state.pinCursor],record=records[item.recordIndex];
      await ctx.effect(async()=>{
        const tab=await getTab(item.id);
        if(tab && tab.windowId===item.windowId && matchesRecord(tab,record) && !!tab.pinned!==item.pinned) {
          try{await api.tabs.update(item.id,{pinned:item.pinned})}
          catch(error){warn('pin',item.id,globalThis.atelierI18n.t("ui_could_not_restore_pinning_b222f2", [error.message]))}
        }
        state.pinCursor++;job.processed=state.pinCursor;
      });
    }
    if(state.pinCursor<state.arrived.length || ctx.cancelled())return false;
    state.stage=groupTitle||groupForRecord?'group':'done';job.processed=0;
    await ctx.checkpoint();
  }
  if(state.stage==='group') {
    job.phase=globalThis.atelierI18n.t("ui_grouping_moved_tabs_a6349a");
    const groupVideos=new Map();
    const stillPlannedGroup=(tab,record,target)=>record.sourceGroupId===undefined||tab.groupId<0||tab.groupId===record.sourceGroupId||tab.groupId===target;
    async function videosIn(groupId) {
      if(!groupVideos.has(groupId)) {
        const videos=new Map();
        for(const tab of (await api.tabs.query({groupId})).sort((a,b)=>a.id-b.id)) {
          if(tab.pendingUrl||tab.status==='loading'||tab.pinned)continue;
          const video=parseYouTubeVideo(tab.url)?.videoId;
          if(video&&!videos.has(video))videos.set(video,tab.id);
        }
        groupVideos.set(groupId,videos);
      }
      return groupVideos.get(groupId);
    }
    const end=Math.min(state.arrived.length,state.groupCursor+10);
    while(state.groupCursor<end && !ctx.cancelled()) {
      const item=state.arrived[state.groupCursor],record=records[item.recordIndex];
      const descriptor=groupForRecord?groupForRecord(record):{title:groupTitle,color:'blue',collapsed:false};
      const groupKey=groupForRecord?`${item.windowId}:${descriptor?.key}`:item.windowId;
      if(!descriptor){state.groupCursor++;job.processed=state.groupCursor;continue}
      let tab=await getTab(item.id);
      if(!tab || tab.windowId!==item.windowId || !matchesRecord(tab,record) || tab.pinned || item.pinned||!stillPlannedGroup(tab,record,state.groups[groupKey])) {
        state.groupPending=null;state.groupCursor++;job.processed=state.groupCursor;continue;
      }
      let groupId=state.groups[groupKey];
      if(groupId!==undefined) {
        let group;try{group=await api.tabGroups.get(groupId)}catch{}
        if(!group||group.windowId!==item.windowId)groupId=undefined;
        else if(state.reusedGroups?.includes(groupId)&&groupNameKey(group.title)!==groupNameKey(groupTitle))throw Error(globalThis.atelierI18n.t("ui_the_existing_group_was_renamed_please_restart_the_ac_4add14"));
        if(groupId===undefined)delete state.groups[groupKey];
      }
      // If Chrome grouped the tab before a worker interruption, adopt the result.
      if(state.groupPending?.tabId===item.id && tab.groupId>=0 && tab.groupId!==state.groupPending.previousGroupId && groupId===undefined) {
        try {if((await api.tabGroups.get(tab.groupId)).windowId===item.windowId)groupId=tab.groupId}catch{}
      }
      if(groupForRecord&&tab.groupId>=0&&tab.groupId!==groupId){
        let existing;try{existing=await api.tabGroups.get(tab.groupId)}catch{}
        if(tab.groupId===descriptor.key&&existing?.windowId===item.windowId&&existing.title===descriptor.title)groupId=tab.groupId;
        else {warn('group',tab.id,globalThis.atelierI18n.t("ui_manual_group_changes_are_preserved_fe63f0"));state.groupPending=null;state.groupCursor++;job.processed=state.groupCursor;continue}
      }
      state.groupPending={tabId:item.id,previousGroupId:tab.groupId??-1};
      await ctx.effect(async()=>{
        tab=await getTab(item.id);
        if(tab && tab.windowId===item.windowId && matchesRecord(tab,record) && !tab.pinned) {
          try {
            const video=reuseGroups?parseYouTubeVideo(tab.url)?.videoId:null;
            const videos=video&&groupId!==undefined?await videosIn(groupId):null;
            const keeperId=videos?.get(video);
            if(keeperId!==undefined&&keeperId!==item.id) {
              const group=await api.tabGroups.get(groupId);
              if(group.windowId!==item.windowId||groupNameKey(group.title)!==groupNameKey(groupTitle))throw Error(globalThis.atelierI18n.t("ui_the_destination_group_changed_dc7c67"));
              const [keeper,loser]=await Promise.all([getTab(keeperId),getTab(item.id)]);
              if(keeper&&loser&&keeper.groupId===groupId&&keeper.windowId===item.windowId&&!keeper.pendingUrl&&keeper.status!=='loading'&&
                !loser.pendingUrl&&loser.status!=='loading'&&!loser.pinned&&matchesRecord(loser,record)&&loser.windowId===item.windowId&&stillPlannedGroup(loser,record,groupId)&&
                !!keeper.incognito===!!loser.incognito&&parseYouTubeVideo(keeper.url)?.videoId===video&&parseYouTubeVideo(loser.url)?.videoId===video&&
                // Same rule as automatic cleanup: an unverified Parker page may neither be closed nor justify closing another tab.
                canCloseYouTubeSource(keeper.url)&&canCloseYouTubeSource(loser.url)) {
                if(ctx.cancelled())return;
                await api.tabs.remove(item.id);state.duplicatesClosed++;await onMoved(item.id);
                state.groupPending=null;state.groupCursor++;job.processed=state.groupCursor;return;
              }
              if(!keeper||keeper.groupId!==groupId||parseYouTubeVideo(keeper.url)?.videoId!==video)videos.delete(video);
            }
            tab=await getTab(item.id);
            if(!tab||!matchesRecord(tab,record)||tab.windowId!==item.windowId||tab.pinned||!stillPlannedGroup(tab,record,groupId))throw Error(globalThis.atelierI18n.t("ui_the_tab_changed_during_grouping_e18c36"));
            if(tab.groupId!==groupId || groupId===undefined) {
              groupId=await api.tabs.group(groupId===undefined?
                {tabIds:[item.id],createProperties:{windowId:item.windowId}}:{tabIds:[item.id],groupId});
            }
            state.groups[groupKey]=groupId;
            await ctx.checkpoint();
            if(!state.reusedGroups?.includes(groupId)&&(!groupForRecord||state.groupMetadataApplied?.[groupKey]!==groupId)){
              await api.tabGroups.update(groupId,{title:descriptor.title,color:descriptor.color||'blue',collapsed:!!descriptor.collapsed});
              (state.groupMetadataApplied??={})[groupKey]=groupId;await ctx.checkpoint();
            }
            if(video){const current=await videosIn(groupId);if(!current.has(video))current.set(video,item.id)}
            state.grouped++;
          } catch(error) {warn('group',item.id,globalThis.atelierI18n.t("ui_moved_but_grouping_is_incomplete_b433db", [error.message]))}
        }
        state.groupPending=null;state.groupCursor++;job.processed=state.groupCursor;
      });
    }
    if(state.groupCursor<state.arrived.length || ctx.cancelled()) {summarize();return false;}
    state.stage='done';
  }
  summarize();job.phase=state.warningCount?globalThis.atelierI18n.t("ui_done_with_warnings_c17e0e"):globalThis.atelierI18n.t("ui_done_25d52d");
  job.processed=job.cursor;job.total=records.length;
  return true;
}
