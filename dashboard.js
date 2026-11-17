import './i18n.js';
import {domainGroups,visibleGroups} from './dashboard-model.js';
const $=id=>document.getElementById(id);
const expanded=new Set(),limits=new Map(),signatures=new Map();
let tabs=[],groups={channels:[],topics:[],isPartial:true},busy=false,loading=false,dirty=true,inventoryDirty=true,timer,revision=0;
let searchTimer,failed=false;
const scope=()=>$('windowFilter').value===''?undefined:Number($('windowFilter').value);
async function request(type,payload={}) {
  const result=await chrome.runtime.sendMessage({type,...payload});
  if(!result?.ok)throw Error(result?.error||globalThis.atelierI18n.t("ui_could_not_connect_to_the_extension_please_reload_the_723eee"));
  return result;
}
function status(text,error=false) {
  $('actionStatus').hidden=!text;$('actionStatus').textContent=text;
  $('actionStatus').classList.toggle('error',error);
}
function element(tag,className,text) {
  const node=document.createElement(tag);node.className=className;
  if(text!==undefined)node.textContent=text;return node;
}
function renderWindows() {
  const selected=$('windowFilter').value,windows=new Map();
  for(const tab of tabs) {
    if(!windows.has(tab.windowId))windows.set(tab.windowId,{count:0,incognito:tab.incognito});
    windows.get(tab.windowId).count++;
  }
  const options=[new Option(globalThis.atelierI18n.t("ui_all_windows_7d53f7"),'')];
  for(const [id,value] of [...windows].sort(([a],[b])=>a-b))options.push(new Option(globalThis.atelierI18n.t("ui_tabs_aff2cf", [value.incognito?globalThis.atelierI18n.t("ui_private_window_15bea0"):globalThis.atelierI18n.t("ui_window_22c978"), id, value.count]),String(id)));
  // A vanished window stays selected and empty; never broaden an action to all windows.
  if(selected && !windows.has(Number(selected)))options.push(new Option(globalThis.atelierI18n.t("ui_window_closed_1b0866", [selected]),selected));
  $('windowFilter').replaceChildren(...options);$('windowFilter').value=selected;
  $('tabTotal').textContent=tabs.length.toLocaleString(globalThis.atelierI18n.locale);$('windowTotal').textContent=globalThis.atelierI18n.t("ui_windows_d519c3", [windows.size]);
}
async function act(kind,group,action) {
  if(busy)return;
  const windowId=scope();
  const title=action==='group' ? await window.atelierDomainGroupName(group.label) : undefined;
  if(action==='group'&&!title)return;
  busy=true;render();
  status(`${group.label}: ${action==='inbox'?globalThis.atelierI18n.t("ui_saving_videos_ccc208"):action==='close'?globalThis.atelierI18n.t("ui_closing_tabs_8b467f"):globalThis.atelierI18n.t("ui_moving_tabs_83140e")} …`);
  try {
    if(action==='inbox') {
      const result=await window.atelierTasks.send('inbox-capture',{groupBy:kind==='channels'?'channel':'topic',groupKey:group.key,windowId,closeTabs:true});
      status(globalThis.atelierI18n.t("ui_videos_saved_to_the_video_inbox_source_tabs_closed_2f48ef", [result.inboxSaved, result.closedTabs, result.skipped?globalThis.atelierI18n.t("ui_changed_or_unavailable_tabs_skipped_7c9f14", [result.skipped]):'']));return;
    }
    if(action==='group') {
      const result=await window.atelierTasks.send('domain-group',{domain:group.key,windowId,title});
      status(window.atelierDomainGroupFeedback(result),Boolean(result.windows));
      return;
    }
    const response=await window.atelierTasks.send(kind==='domains'?`domain-${action}`:action==='close'?'close-group-tabs':'move-group-to-window',
      kind==='domains'?{domain:group.key,windowId}:{groupBy:kind==='channels'?'channel':'topic',groupKey:group.key,windowId});
    const count=kind==='domains'?response.count:action==='close'?response.closedTabs:response.movedTabs;
    status(globalThis.atelierI18n.t("ui_tabs_cd6028", [group.label, count??0, action==='close'?globalThis.atelierI18n.t("ui_closed_da731d"):globalThis.atelierI18n.t("ui_processed_14493b"), response.duplicatesClosed?globalThis.atelierI18n.t("ui_duplicate_videos_closed_878ef0", [response.duplicatesClosed]):'', response.skipped?globalThis.atelierI18n.t("ui_changed_tabs_skipped_0b1b55", [response.skipped]):'', response.warningCount?globalThis.atelierI18n.t("ui_see_the_task_list_for_details_d378c1"):'']));
  } catch(error){status(error.message,true)}
  finally{busy=false;invalidate(true);render()}
}
function renderColumn(kind,items,byId) {
  const list=$(kind),shown=visibleGroups(items,byId,{search:$('search').value,minimum:kind==='domains'?1:Number($('minimum').value),sort:$('sort').value});
  $(kind+'Count').textContent=String(shown.length);
  const signature=JSON.stringify([shown,busy,kind!=='domains'&&groups.isPartial,[...expanded],[...limits],shown.flatMap(group=>expanded.has(kind+':'+group.key)?group.tabIds.map(id=>byId.get(id)):[])]);
  if(signatures.get(kind)===signature)return;signatures.set(kind,signature);
  const scroll=list.scrollTop,fragment=document.createDocumentFragment();
  const focusKey=list.contains(document.activeElement)?document.activeElement.dataset.focusKey:undefined;
  if(!shown.length)fragment.append(element('p','empty',kind!=='domains'&&groups.isPartial?globalThis.atelierI18n.t("ui_analyzing_youtube_groups_will_appear_here_as_they_ar_2de02f"):$('search').value?globalThis.atelierI18n.t("ui_no_matching_groups_d24db9"):globalThis.atelierI18n.t("ui_no_groups_for_this_selection_77e588")));
  for(const group of shown) {
    const key=kind+':'+group.key,open=expanded.has(key),card=element('article','card'),line=element('div','group-line');
    const toggle=element('button','expand');toggle.type='button';toggle.setAttribute('aria-expanded',String(open));
    toggle.dataset.focusKey=`${key}:expand`;
    toggle.append(element('span','chevron',open?'▾':'▸'),element('span','group-name',globalThis.atelierI18n.label(group.label)));
    toggle.addEventListener('click',()=>{if(open)expanded.delete(key);else expanded.add(key);render()});
    line.append(toggle,element('span','count',String(group.count)));
    for(const action of (kind==='domains'?['window','group','close']:['inbox','window','close'])) {
      const button=element('button','group-action '+(action==='close'?'close':''),globalThis.atelierI18n.t({window:'actionWindow',group:'actionGroup',close:'actionClose',inbox:'actionInbox'}[action]));button.type='button';
      button.title=globalThis.atelierI18n.t("ui_tabs_from_1e2286", [group.count, group.label, action==='group'?globalThis.atelierI18n.t('actionGroup'):action==='inbox'?globalThis.atelierI18n.t("ui_save_to_the_video_inbox_and_close_after_storage_is_v_95a725"):action==='close'?globalThis.atelierI18n.t("ui_close_e0b9f0"):kind==='domains'?globalThis.atelierI18n.t("ui_collect_in_a_new_window_with_no_per_window_tab_limit_dc3187"):globalThis.atelierI18n.t("ui_collect_in_one_group_merge_matching_groups_and_close_a4172d")]);
      button.dataset.focusKey=`${key}:${action}`;
      button.setAttribute('aria-label',button.title);button.disabled=busy||(kind!=='domains'&&groups.isPartial);
      button.addEventListener('click',()=>act(kind,group,action));line.append(button);
    }
    card.append(line);
    if(open) {
      const ul=element('ul','tabs'),limit=limits.get(key)||40;
      for(const id of group.tabIds.slice(0,limit)) {
        const tab=byId.get(id);if(!tab)continue;
        const li=element('li',''),link=element('button','tab-link',`${tab.pinned?'⌖ ':''}${tab.title||tab.url}`);link.type='button';link.title=tab.url;
        link.dataset.focusKey=`${key}:tab:${id}`;
        link.append(element('small','',`${tab.incognito?globalThis.atelierI18n.t("ui_private_window_15bea0"):globalThis.atelierI18n.t("ui_window_22c978")} ${tab.windowId} · ${tab.domain}`));
        link.addEventListener('click',()=>request('focus-dashboard-tab',{tabId:id}).catch(error=>{status(error.message,true);invalidate(true)}));
        li.append(link);ul.append(li);
      }
      card.append(ul);
      if(group.count>limit) {
        const more=element('button','more',globalThis.atelierI18n.t("ui_show_more_8824bc", [group.count-limit]));more.type='button';
        more.dataset.focusKey=`${key}:more`;
        more.addEventListener('click',()=>{limits.set(key,limit+40);render()});card.append(more);
      }
    }
    fragment.append(card);
  }
  list.replaceChildren(fragment);list.scrollTop=scroll;
  if(focusKey)[...list.querySelectorAll('button')].find(button=>button.dataset.focusKey===focusKey)?.focus({preventScroll:true});
}
function render() {
  const titleSearch=$('search').value.trim(),params=new URLSearchParams({titleSearch});
  if(scope()!==undefined)params.set('windowId',String(scope()));
  $('captureSearchAction').hidden=!titleSearch;
  $('captureMatches').href=`inbox.html?${params}`;
  const selected=tabs.filter(tab=>scope()===undefined||tab.windowId===scope()),byId=new Map(selected.map(tab=>[tab.id,tab]));
  $('scopeLabel').textContent=globalThis.atelierI18n.t("ui_tabs_selected_20a80e", [scope()===undefined?globalThis.atelierI18n.t("ui_all_windows_7d53f7"):globalThis.atelierI18n.t("ui_window_0cd291", [scope()]), selected.length]);
  renderColumn('domains',domainGroups(selected),byId);
  renderColumn('channels',groups.channels,byId);renderColumn('topics',groups.topics,byId);
  $('scanProgress').hidden=!groups.isPartial;$('scanProgress').max=Math.max(1,groups.matchedTabs||0);$('scanProgress').value=groups.resolvedTabs||0;
  $('scanStatus').textContent=groups.isPartial?globalThis.atelierI18n.t("ui_youtube_analysis_tabs_group_actions_available_when_f_e0bc22", [groups.resolvedTabs||0, groups.matchedTabs||0]):globalThis.atelierI18n.t("ui_youtube_tabs_analyzed_view_up_to_date_78fc28", [groups.matchedTabs||0]);
}
function invalidate(inventory=false) {
  revision++;dirty=true;inventoryDirty ||= inventory;
  groups.isPartial=true;if(!document.hidden)render();schedule(250);
}
function schedule(delay) {
  clearTimeout(timer);if(!document.hidden)timer=setTimeout(refresh,delay);
}
async function refresh() {
  if(loading||document.hidden)return;
  loading=true;failed=false;const current=revision,windowId=scope();dirty=false;
  try {
    if(inventoryDirty) {
      inventoryDirty=false;
      try {tabs=(await request('get-dashboard-tabs')).tabs;renderWindows();render()}
      catch(error){inventoryDirty=true;throw error}
    }
    const snapshot=await request('get-dashboard-groups',{windowId});
    if(current!==revision){dirty=true;return}
    groups=snapshot;render();
    if(snapshot.cacheError)status(globalThis.atelierI18n.t("ui_youtube_cache_01777e", [snapshot.cacheError]),true);
  } catch(error){failed=true;status(error.message,true)}
  finally{loading=false;if(dirty||groups.isPartial||failed)schedule(failed?5000:500)}
}
$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(render,120)});
$('minimum').addEventListener('change',render);$('sort').addEventListener('change',render);
$('windowFilter').addEventListener('change',()=>{groups={channels:[],topics:[],isPartial:true};invalidate()});
$('refresh').addEventListener('click',()=>{status('');invalidate(true)});
chrome.runtime.onMessage.addListener(message=>{
  if(['domains-invalidated','groups-invalidated'].includes(message?.type))invalidate(true);
});
chrome.tabs.onUpdated.addListener((_id,change)=>{if(change.title!==undefined)invalidate(true)});
chrome.tabs.onAttached.addListener(()=>invalidate(true));
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else invalidate(true)});
window.addEventListener('unload',()=>{clearTimeout(timer);clearTimeout(searchTimer)});
refresh();
