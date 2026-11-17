import {identifyTabParker} from './youtube-url.js';
import './i18n.js';
import {INBOX_PAGE_SIZE, inboxMetadata,matchesMissing} from './inbox-model.js';
const $=id=>document.getElementById(id),openGroups=new Set(),limits=new Map();
const viewFields=['search','statusFilter','groupBy','sortBy','openTarget','metadataFilter'];
let collection={},groupOffset=0,busy=false,batchBusy=false,timer,searchTimer,loadVersion=0,previewVersion=0,captureTimer,enrichBusy=false;
try{const saved=JSON.parse(sessionStorage.getItem('inboxViewV1')||'{}');for(const id of viewFields)if(typeof saved[id]==='string'&&(id==='search'||[...$(id).options].some(option=>option.value===saved[id])))$(id).value=saved[id]}catch{}
function rememberView(){try{sessionStorage.setItem('inboxViewV1',JSON.stringify(Object.fromEntries(viewFields.map(id=>[id,$(id).value]))))}catch{}}
const filters=()=>({search:$('search').value.slice(0,200),status:$('statusFilter').value,
  sort:$('sortBy').value,mode:$('groupBy').value,missing:$('metadataFilter').value});
const showGroup=key=>{
  openGroups.delete(key);openGroups.add(key);
  if(openGroups.size>4)openGroups.delete(openGroups.values().next().value);
};
const scope=()=>$('captureWindow').value===''?undefined:Number($('captureWindow').value);
const captureOptions=()=>({windowId:scope(),includePrivate:$('includePrivate').checked,
  titleSearch:$('captureSearch').value,parkedOnly:$('parkedOnly').checked});
// A dashboard search opens a separate, explicitly scoped capture preview.
const captureParams=new URLSearchParams(location.search);
if(captureParams.has('titleSearch'))$('captureSearch').value=captureParams.get('titleSearch').slice(0,200);
if(captureParams.get('parkedOnly')==='1')$('parkedOnly').checked=true;
const requestedWindow=captureParams.get('windowId');
if(requestedWindow&&/^\d+$/.test(requestedWindow)){
  $('captureWindow').add(new Option(globalThis.atelierI18n.t('ui_window_0cd291',[requestedWindow]),requestedWindow));
  $('captureWindow').value=requestedWindow;
}
async function request(type,payload={}) {
  const response=await chrome.runtime.sendMessage({type,...payload});
  if(!response?.ok)throw Error(response?.error||globalThis.atelierI18n.t("ui_could_not_connect_to_the_extension_please_reload_the_723eee"));return response;
}
function notice(text,error=false){$('notice').hidden=!text;$('notice').textContent=text;$('notice').classList.toggle('error',error)}
function element(tag,className,text){const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node}
async function openVideo(videoId){
  try {
    const result=await window.atelierTasks.send('inbox-open',{videoId});
    if(result.limitSkipped)notice(globalThis.atelierI18n.t('inboxReviewLimited',[result.limitSkipped]));
  }catch(error){notice(error.message,true)}
}
function videoRow(item) {
  const row=element('article','video-row'),info=element('div','video-info'),title=element('button','video-title',item.title);title.type='button';title.title=item.openUrl;title.addEventListener('click',()=>openVideo(item.videoId));
  const meta=element('p','',inboxMetadata(item));
  for(const [kind,label] of [['title','inboxMissingTitle'],['channel','inboxMissingChannel'],['topic','inboxMissingTopic']]){
    if(matchesMissing(item,kind))meta.append(element('span','incomplete',globalThis.atelierI18n.t(label)));
  }
  info.append(title,meta);
  const done=element('input','done-check');done.type='checkbox';done.checked=item.status==='done';done.dataset.videoStatus='done:'+item.videoId;done.setAttribute('aria-label',globalThis.atelierI18n.t("ui_done_92efac", [item.title]));done.title=globalThis.atelierI18n.t("ui_mark_as_done_d6ed71");
  const select=element('select','');select.dataset.videoStatus=item.videoId;select.setAttribute('aria-label',globalThis.atelierI18n.t("ui_status_of_998755", [item.title]));
  for(const [value,text] of [['open',globalThis.atelierI18n.t("ui_open_64509e")],['done',globalThis.atelierI18n.t("ui_done_467e01")],['keep',globalThis.atelierI18n.t("ui_keep_27d1d9")]])select.add(new Option(text,value));select.value=item.status;
  async function setStatus(status){
    select.disabled=true;done.disabled=true;
    try{await request('inbox-set-status',{videoId:item.videoId,status});await load()}
    catch(error){select.value=item.status;done.checked=item.status==='done';notice(error.message,true)}finally{select.disabled=false;done.disabled=false}
  }
  select.addEventListener('change',()=>setStatus(select.value));
  done.addEventListener('change',()=>setStatus(done.checked?'done':'open'));
  const button=element('button','row-open',globalThis.atelierI18n.t("ui_open_e8b31f"));button.type='button';button.addEventListener('click',()=>openVideo(item.videoId));
  const topicButton=element('button','topic-edit',globalThis.atelierI18n.t('inboxTopicEdit'));
  topicButton.type='button';topicButton.dataset.videoStatus='topic:'+item.videoId;
  topicButton.addEventListener('click',()=>{
    $('topicEditorVideo').textContent=item.title;
    $('topicEditorValue').value=item.topicOverride||'';
    $('topicEditor').dataset.videoId=item.videoId;
    $('topicEditor').returnValue='';
    $('topicEditor').showModal();
  });
  info.append(topicButton);
  row.append(done,info,select,button);return row;
}
function updateBatchControls() {
  const count=collection.matched||0,reopen=$('statusFilter').value==='done';
  $('batchCount').textContent=globalThis.atelierI18n.t("ui_all_matches_0aa9cc", [count]);
  $('openBatch').textContent=globalThis.atelierI18n.t('reviewChoose');
  $('doneBatch').textContent=reopen?globalThis.atelierI18n.t("ui_mark_as_open_66470f", [count]):globalThis.atelierI18n.t("ui_mark_as_done_4565c7", [count]);
  for(const id of ['openBatch','doneBatch'])$(id).disabled=batchBusy||!count;
  for(const button of $('collection').querySelectorAll('[data-open-inbox-group]'))button.disabled=batchBusy;
  $('openTarget').disabled=batchBusy;
}
function render() {
  const mode=$('groupBy').value, view=collection,fragment=document.createDocumentFragment();
  $('inboxTotal').textContent=view.total.toLocaleString(globalThis.atelierI18n.locale);
  $('openTotal').textContent=globalThis.atelierI18n.t("ui_still_open_6d052b",[view.open]);
  $('resultCount').textContent=globalThis.atelierI18n.t("ui_of_videos_a8a0d6",[view.matched,view.total,
    mode==='none'?'':` · ${view.groupCount} ${globalThis.atelierI18n.t(mode==='channel'?'ui_channels_d459d5':'ui_topics_6de8f4')}`]);
  if(!view.matched){
    const empty=element('div','empty-state');
    empty.append(element('p','',globalThis.atelierI18n.t(view.total?'ui_nothing_here_right_now_239caa':'ui_a_good_place_for_later_b2851a')));
    fragment.append(empty);
  }
  for(const group of view.groups){
    if(!group.count)continue;
    const {key,label,count,offset}=group;
    const details=element('details','video-group'),summary=element('summary',''),rows=element('div','video-rows');
    summary.append(element('h2','',globalThis.atelierI18n.label(label)),element('small','',globalThis.atelierI18n.t("ui_videos_5331a0",[count])));
    if(mode!=='none'){
      const open=element('button','group-open',globalThis.atelierI18n.t('reviewChoose'));
      open.type='button';open.dataset.openInboxGroup=key;
      open.setAttribute('aria-label',globalThis.atelierI18n.t("ui_only_open_videos_in_one_group_5e6657",[label,count]));
      open.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();showReview(count,key)});
      summary.append(open);
    }
    details.append(summary,rows);
    details.open=mode==='none'||openGroups.has(key);
    for(const item of group.rows)rows.append(videoRow(item));
    if(group.rows.length&&(offset>0||offset+group.rows.length<count)){
      const navigation=element('div','inbox-pagination');
      navigation.append(element('span','',globalThis.atelierI18n.t('inboxPageRange',[offset+1,offset+group.rows.length,count])));
      for(const [available,step,name] of [[offset>0,-1,'inboxPagePrevious'],[offset+INBOX_PAGE_SIZE<count,1,'inboxPageNext']]){
        const button=element('button','',globalThis.atelierI18n.t(name));button.type='button';button.disabled=!available;
        button.addEventListener('click',()=>{limits.set(key,offset+step*INBOX_PAGE_SIZE);load()});
        navigation.append(button);
      }
      rows.append(navigation);
    }
    details.addEventListener('toggle',()=>{
      if(mode==='none'||!details.isConnected||details.open===openGroups.has(key))return;
      if(details.open)showGroup(key);else{openGroups.delete(key);limits.delete(key)}
      load();
    });
    fragment.append(details);
  }
  const active=document.activeElement,focusedId=active?.dataset.videoStatus,top=window.scrollY;
  const rowPosition=focusedId?[...$('collection').querySelectorAll('.video-row')].indexOf(active.closest('.video-row')):-1;
  $('collection').replaceChildren(fragment);
  if(focusedId){
    const rows=[...$('collection').querySelectorAll('.video-row')];
    const current=[...$('collection').querySelectorAll('[data-video-status]')].find(control=>control.dataset.videoStatus===focusedId);
    const nearby=rows[Math.min(rowPosition,rows.length-1)]?.querySelector('[data-video-status]');
    (current||nearby||$('statusFilter')).focus({preventScroll:true});
  }
  window.scrollTo(0,top);
  updateBatchControls();
  groupOffset=view.groupOffset;
  $('previousGroups').hidden=groupOffset===0;
  $('more').hidden=groupOffset+view.groups.length>=view.groupCount;
}
let reviewScope,reviewPreview,reviewRevision=0;
function showReview(count,groupKey){
  if(batchBusy||!count)return;
  const tr=globalThis.atelierI18n.t;
  reviewScope={filters:filters(),groupKey};
  $('reviewAmount').replaceChildren();
  for(const size of [10,20])if(count>size)$('reviewAmount').add(new Option(String(size),String(size)));
  $('reviewAmount').add(new Option(tr('reviewAll',[count]),'all'));
  $('reviewTitle').textContent=tr('reviewChoose');
  $('reviewDialog').showModal();
  updateReview();
}
async function updateReview(){
  const revision=++reviewRevision,tr=globalThis.atelierI18n.t;
  reviewPreview=null;$('reviewSubmit').disabled=true;$('reviewException').hidden=true;
  $('reviewSummary').textContent=tr('reviewChecking');
  const value=$('reviewAmount').value;
  const scope={...reviewScope,amount:value==='all'?value:Number(value)};
  try{
    const result=await request('inbox-review-preview',scope);
    if(revision!==reviewRevision||!$('reviewDialog').open)return;
    reviewPreview={...scope,...result};
    $('reviewTitle').textContent=result.title;
    $('reviewSummary').textContent=tr('reviewSummary',[result.count,result.fresh]);
    $('reviewException').hidden=!result.needsException;
    $('reviewSubmit').textContent=tr(result.needsException?'reviewOpenException':'reviewOpenCount',[result.count]);
    $('reviewSubmit').disabled=false;
  }catch(error){if(revision===reviewRevision)$('reviewSummary').textContent=error.message}
}
$('reviewAmount').addEventListener('change',updateReview);
$('reviewCancel').addEventListener('click',()=>$('reviewDialog').close());
$('reviewDialog').addEventListener('close',()=>{reviewRevision++;reviewPreview=null});
$('reviewForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(batchBusy||!reviewPreview)return;
  const {filters,groupKey,amount,count,needsException,selectionKey}=reviewPreview;
  const target=$('openTarget').value;
  rememberView();$('reviewDialog').close();
  batchBusy=true;updateBatchControls();
  const tr=globalThis.atelierI18n.t;
  notice(tr('reviewOpening'));
  try{
    const result=await window.atelierTasks.send('inbox-review-start',{filters,groupKey,amount,count,selectionKey,target,bypass:needsException});
    notice(tr('reviewResult',[result.groupedTabs,result.createdTabs,result.reusedTabs,result.skipped+result.limitSkipped]));
  }catch(error){notice(error.message,true)}
  finally{batchBusy=false;updateBatchControls();await loadWindows()}
});
$('openBatch').addEventListener('click',()=>showReview(collection.matched));
$('doneBatch').addEventListener('click',async()=>{
  if(batchBusy||!collection.matched)return;
  const status=$('statusFilter').value==='done'?'open':'done';
  batchBusy=true;updateBatchControls();
  try{
    const result=await request('inbox-set-filtered-status',{...filters(),matchStatus:filters().status,status});
    notice(globalThis.atelierI18n.t("ui_videos_marked_as_titles_channels_links_and_dates_add_8c77ba",[result.count,globalThis.atelierI18n.t(status==='done'?"ui_done_967f15":"ui_open_9a8089")]));
    await load();
  }catch(error){notice(error.message,true)}
  finally{batchBusy=false;updateBatchControls()}
});
$('topicEditor').addEventListener('close',async()=>{
  if($('topicEditor').returnValue!=='save')return;
  try{await request('inbox-set-topic',{videoId:$('topicEditor').dataset.videoId,topic:$('topicEditorValue').value});await load()}
  catch(error){notice(error.message,true)}
});
async function load(){
  const version=++loadVersion, options=filters();
  const keys=options.mode==='none'?['all']:[...openGroups];
  const pages=keys.map(key=>[key,limits.get(key)||0]);
  try{
    const result=await request('inbox-query',{...options,groupOffset,pages});
    if(version!==loadVersion)return;
    collection=result;render();
  }catch(error){notice(error.message,true)}
}
async function preview(){
  const version=++previewVersion;$('capture').disabled=true;$('enrichParked').disabled=true;
  try{const result=await request('inbox-preview',captureOptions());if(version!==previewVersion)return;
    $('capturePreview').textContent=globalThis.atelierI18n.t("ui_currently_youtube_tabs_unique_videos_ae6b7c", [result.tabCount, result.videoCount]);$('capture').disabled=busy||enrichBusy||!result.videoCount;$('enrichParked').disabled=busy||enrichBusy||!result.videoCount;
    const samples=(result.videos||[]).map(video=>element('li','',video.title||`YouTube · ${video.videoId}`));
    $('captureSamples').replaceChildren(...samples);$('captureSamples').hidden=!samples.length;
  }catch(error){if(version!==previewVersion)return;$('capturePreview').textContent=error.message;$('captureSamples').hidden=true}
}
async function loadWindows(){
  try{
    const response=await request('get-dashboard-tabs'),selected=$('captureWindow').value,windows=new Map();
    for(const tab of response.tabs)windows.set(tab.windowId,(windows.get(tab.windowId)||0)+1);
    const options=[new Option(globalThis.atelierI18n.t("ui_all_windows_7d53f7"),'')];
    for(const [id,count] of windows)options.push(new Option(globalThis.atelierI18n.t("ui_window_tabs_9ef06a", [id, count]),String(id)));
    if(selected&&!windows.has(Number(selected)))options.push(new Option(globalThis.atelierI18n.t("ui_window_closed_1b0866", [selected]),selected));
    $('captureWindow').replaceChildren(...options);$('captureWindow').value=selected;await preview();
  }catch(error){notice(error.message,true)}
}
$('enrichParked').addEventListener('click',async()=>{
  if(busy||enrichBusy)return;enrichBusy=true;$('enrichParked').disabled=true;$('capture').disabled=true;
  try {
    notice(globalThis.atelierI18n.t('ui_parked_info_progress'));
    const result=await window.atelierTasks.send('parked-info-enrich',{...captureOptions(),parkedOnly:true,includePrivate:false});
    notice(globalThis.atelierI18n.t('ui_parked_info_done',[result.enriched,result.total]));await load();
  }catch(error){notice(error.message,true)}finally{enrichBusy=false;await preview()}
});
$('capture').addEventListener('click',async()=>{
  if(busy||enrichBusy)return;busy=true;$('capture').disabled=true;
  const payload={...captureOptions(),closeTabs:$('closeSaved').checked};
  for(const id of ['captureSearch','parkedOnly','captureWindow','includePrivate','closeSaved'])$(id).disabled=true;
  notice(globalThis.atelierI18n.t("ui_saving_videos_follow_progress_in_the_task_list_3ef094"));
  try{
    const result=await window.atelierTasks.send('inbox-capture',payload);
    notice(globalThis.atelierI18n.t("ui_unique_videos_saved_tabs_closed_34844e", [result.inboxSaved, result.closedTabs, result.skipped?globalThis.atelierI18n.t("ui_changed_or_unavailable_tabs_skipped_d374fa", [result.skipped]):'', result.metadataIncomplete?globalThis.atelierI18n.t("ui_title_or_channel_information_is_still_missing_for_vi_1e0877", [result.metadataIncomplete]):'']));
    await load();
  }catch(error){notice(error.message+globalThis.atelierI18n.t("ui_videos_already_saved_stay_in_the_inbox_4af5df"),true);await load()}
  finally{busy=false;for(const id of ['captureSearch','parkedOnly','captureWindow','includePrivate','closeSaved'])$(id).disabled=false;await loadWindows()}
});
$('closeSaved').addEventListener('change',()=>{$('capture').textContent=$('closeSaved').checked?globalThis.atelierI18n.t("ui_save_close_tabs_9a28ef"):globalThis.atelierI18n.t("ui_save_videos_060866")});
$('captureWindow').addEventListener('change',preview);$('includePrivate').addEventListener('change',preview);$('parkedOnly').addEventListener('change',preview);
$('captureSearch').addEventListener('input',()=>{
  ++previewVersion;clearTimeout(captureTimer);$('capture').disabled=true;$('enrichParked').disabled=true;$('captureSamples').hidden=true;
  $('capturePreview').textContent=globalThis.atelierI18n.t('ui_counting_open_youtube_videos_eaf1c8');
  captureTimer=setTimeout(preview,150);
});
for(const id of ['statusFilter','groupBy','sortBy','metadataFilter'])$(id).addEventListener('change',()=>{groupOffset=0;limits.clear();rememberView();load()});
$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{groupOffset=0;limits.clear();rememberView();load()},120)});
$('openTarget').addEventListener('change',rememberView);
$('more').addEventListener('click',()=>{groupOffset+=40;load()});
$('previousGroups').addEventListener('click',()=>{groupOffset=Math.max(0,groupOffset-40);load()});
$('refresh').addEventListener('click',()=>{load();loadWindows()});
$('backup').addEventListener('click',async()=>{
  $('backup').disabled=true;let url;
  try{const result=await request('inbox-export');url=URL.createObjectURL(new Blob([JSON.stringify(result.backup,null,2)],{type:'application/json'}));
    await chrome.downloads.download({url,filename:`tab-atelier-inbox-${new Date().toISOString().slice(0,10)}.json`,saveAs:true,conflictAction:'uniquify'});
    notice(globalThis.atelierI18n.t("ui_backup_sent_to_chrome_check_downloads_for_completion_363084"));
  }catch(error){notice(error.message,true)}finally{if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);$('backup').disabled=false}
});
$('restore').addEventListener('click',()=>$('restoreFile').click());
$('restoreFile').addEventListener('change',async()=>{
  const file=$('restoreFile').files[0];if(!file)return;$('restore').disabled=true;
  try{if(file.size>6_000_000)throw Error(globalThis.atelierI18n.t("ui_the_backup_must_not_exceed_6_mb_903f1b"));const backup=JSON.parse(await file.text());
    const result=await window.atelierTasks.send('inbox-restore',{backup});notice(globalThis.atelierI18n.t("ui_entries_imported_existing_videos_were_merged_and_the_5d849c", [result.inboxSaved]));await load();
  }catch(error){notice(error.message,true)}finally{$('restore').disabled=false;$('restoreFile').value=''}
});
chrome.runtime.onMessage.addListener(message=>{if(message?.type==='inbox-changed'&&!document.hidden){clearTimeout(timer);timer=setTimeout(load,500)}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){load();loadWindows()}});
async function metadataProgress(){
  try{
    const info=await request('inbox-metadata-status');
    $('autoMetadata').checked=info.enabled;
    $('autoMetadata').disabled=false;
    $('metadataProgress').textContent=info.enabled?globalThis.atelierI18n.t(info.waiting?'inboxAutoWaiting':'inboxAutoProgress',[info.filled,info.total]):'';
  }catch(error){$('metadataProgress').textContent=error.message}
}
$('autoMetadata').addEventListener('change',async()=>{
  const autoMetadata=$('autoMetadata').checked;
  $('autoMetadata').disabled=true;
  try{await request('tab-automation-settings',{patch:{autoMetadata}})}
  catch(error){notice(error.message,true)}
  await metadataProgress();
});
chrome.runtime.onMessage.addListener(message=>{if(message?.type==='inbox-metadata-progress')metadataProgress()});
load();loadWindows();metadataProgress();

async function restoreParkedTabs(tabId){
  const status=await request('parker-update-status');
  const ids=[...new Set(status.entries.filter(entry=>tabId===undefined||entry.tabId===tabId).map(entry=>entry.ownerId))];
  const checked=await Promise.all(ids.map(async id=>await identifyTabParker(chrome,id)?id:null));
  return request('parker-update-restore',{tabId,readyOwners:checked.filter(Boolean)});
}
function restoredParkerMessage(result){
  const t=globalThis.atelierI18n.t;
  return result.unavailable?t('ui_update_parker_unavailable'):t('ui_update_restored',[result.restored,result.skipped]);
}
async function updateMigrationStatus(showSummary=true){
  try{
    const result=await request('parker-update-status');
    $('restoreParker').disabled=!result.pending;
    $('prepareParker').disabled=!!result.pending&&!result.preparable;
    $('updateEntriesPanel').hidden=!result.pending;
    const list=$('updateEntries');
    list.replaceChildren();
    for(const entry of result.entries||[]){
      const row=document.createElement('li');
      const name=document.createElement('span');name.textContent=entry.title+' ';
      row.append(name);
      for(const [enabled,operation,label] of [
        [entry.canPrepare,'prepare','ui_update_prepare'],
        [entry.canRestore,'restore','ui_update_restore']
      ]){
        if(!enabled)continue;
        const button=document.createElement('button');
        button.type='button';button.textContent=globalThis.atelierI18n.t(label);
        button.addEventListener('click',async()=>{
          button.disabled=true;
          try{
            const outcome=operation==='restore'?await restoreParkedTabs(entry.tabId):await request('parker-update-prepare',{tabId:entry.tabId});
            $('updateStatus').textContent=operation==='prepare'
              ?globalThis.atelierI18n.t('ui_update_held',[outcome.held,outcome.total])
              :restoredParkerMessage(outcome);
          }catch(error){$('updateStatus').textContent=error.message}
          finally{await updateMigrationStatus(false)}
        });
        row.append(button);
      }
      list.append(row);
    }
    if(result.pending){
      $('parkerUpdate').open=true;
      if(showSummary)$('updateStatus').textContent=globalThis.atelierI18n.t('ui_update_pending',[result.held,result.pending]);
    }
  }catch{}
}
$('prepareParker').addEventListener('click',async()=>{
  $('prepareParker').disabled=true;
  try{const result=await request('parker-update-prepare');$('updateStatus').textContent=globalThis.atelierI18n.t('ui_update_held',[result.held??result.pending,result.total??result.pending]);await updateMigrationStatus()}
  catch(error){$('updateStatus').textContent=error.message;$('prepareParker').disabled=false}
});
$('restoreParker').addEventListener('click',async()=>{
  $('restoreParker').disabled=true;
  try{const result=await restoreParkedTabs();$('updateStatus').textContent=restoredParkerMessage(result);await updateMigrationStatus(false)}
  catch(error){$('updateStatus').textContent=error.message;$('restoreParker').disabled=false}
});
updateMigrationStatus();
