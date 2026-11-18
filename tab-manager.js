import {reviewProtection} from './inbox-review-protection.js';
import './i18n.js';
import { transferStep } from "./tab-transfer.js";
import { isTrustedPage, validateWindowId } from "./extension-pages.js";
import { tabUrl, domainOf, duplicateKey, duplicatePairs, domainSummary, windowSortPlan, domainMatches } from "./tab-rules.js";

import { navigationKey, tabParkerTarget, parseYouTubeTab, canCloseYouTubeSource } from "./youtube-url.js";
import { runExclusive } from "./action-coordinator.js";
import { createTabIndex } from "./tab-index.js";
import { groupNameKey } from "./group-reuse.js";
import { taskService } from "./task-runner.js";
import {readTabSettings,isLimitPage,assertTabCapacity} from "./tab-settings.js";
import {isGrouped,rememberDomainWindow,domainWindowTargets,domainContext} from './window-policy.js';
const index = createTabIndex(chrome);
const tasks = taskService();
const STATE_KEY = "tabManagerSessionV1";
const AUTO_KEY = "automaticDuplicatesEnabledV1";
const NEW_TAB_MAX_AGE_MS = 120_000;
const STARTUP_GRACE_MS = 30_000;
const enqueue = task => runExclusive(task);
let lastSaved = "";
let initialized = false;
let flushTimer;
let publicationVersion=0,lastPublication=-1,lastBadge=null;
const updates = new Set(), removals = new Set();
let state;
const pendingCreations = new Map();
let creationSequence = 0;
let automaticEnabled = false;
let settingsLoaded = false;

async function loadAutoSetting() {
  if (!settingsLoaded) {
    const stored = await chrome.storage.local.get(AUTO_KEY);
    // Opt-in: closing a tab discards its state (e.g. playback position), so it
    // only happens after the user enabled it in the popup.
    automaticEnabled = stored[AUTO_KEY] === true;
    settingsLoaded = true;
  }
}

async function saveState() {
  const serialized = JSON.stringify(state);
  if (serialized === lastSaved) return;
  await chrome.storage.session.set({ [STATE_KEY]: state });
  lastSaved = serialized;
}
async function ensureIndex() {
  const tabs = await index.snapshot();
  if (!initialized) { await track(tabs); initialized = true; }
  return tabs;
}

async function track(tabs) {
  if (!state) state = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || {
    next: 1, order: {}, autoGraceUntil: Date.now() + STARTUP_GRACE_MS
  };
  state.openedAt ??= {};
  state.pendingChecks ??= {};
  state.closeLog ??= [];
  const ids = new Set(tabs.map(tab => String(tab.id)));
  const creations = new Map([...pendingCreations].filter(([id]) => ids.has(String(id))));
  for (const id of Object.keys(state.order)) if (!ids.has(id)) {
    delete state.order[id];
    delete state.openedAt[id];
    delete state.pendingChecks[id];
  }
  // Capture event order before queued work runs, including bursts of new tabs.
  // Unknown pre-existing tabs sort first; their true opening time is unavailable.
  const sorted = [...tabs].sort((a, b) =>
    Number(creations.has(a.id)) - Number(creations.has(b.id)) ||
    (creations.get(a.id)?.sequence ?? a.id) - (creations.get(b.id)?.sequence ?? b.id));
  for (const tab of sorted) {
    const created = creations.get(tab.id);
    if (state.order[tab.id] === undefined || (created && state.openedAt[tab.id] == null)) {
      state.order[tab.id] = state.next++;
      state.openedAt[tab.id] = created?.at ?? null;
    }
    if (created && !tab.discarded && created.at >= (state.autoGraceUntil || 0)) {
      state.pendingChecks[tab.id] = { at: created.at, requestedUrl: created.requestedUrl };
    }
  }
  for (const [id, candidate] of Object.entries(state.pendingChecks)) {
    if (!ids.has(id) || Date.now() - candidate.at > NEW_TAB_MAX_AGE_MS) delete state.pendingChecks[id];
  }
  await saveState();
  for (const [id, created] of creations) {
    if (pendingCreations.get(id) === created) pendingCreations.delete(id);
  }
}

async function getTab(id) {
  try { return await chrome.tabs.get(id); } catch { return null; }
}

async function publish(force=true) {
  if(force)publicationVersion++;
  if(publicationVersion===lastPublication)return;
  const version=publicationVersion,tabs=await index.snapshot();
  if(lastBadge!==tabs.length) {
    await chrome.action.setBadgeBackgroundColor({color:"#176BB0"});
    await chrome.action.setBadgeText({text:String(tabs.length)});
    await chrome.action.setTitle({title:globalThis.atelierI18n.t("ui_tab_atelier_open_tabs_959d90", [tabs.length])});
    lastBadge=tabs.length;
  }
  await chrome.runtime.sendMessage({type:"domains-invalidated"}).catch(()=>{});
  lastPublication=version;
}

async function reconcile(triggerId = null, providedPairs = null) {
  await loadAutoSetting();
  const tabs = await ensureIndex();
  let candidates = tabs;
  if (triggerId !== null) {
    const candidate = state.pendingChecks[triggerId];
    const trigger = tabs.find(tab => tab.id === triggerId);
    if (!automaticEnabled || !candidate || !trigger) return { ok: true, closed: 0 };
    const intendedUrl = tabUrl(trigger);
    if (!candidate.requestedUrl && (/^https?:\/\//i.test(intendedUrl) || tabParkerTarget(intendedUrl))) candidate.requestedUrl = intendedUrl;
    // Redirects must not turn a newly opened link into a deletion of an unrelated
    // login/landing page. Pending and discarded tabs never establish a duplicate.
    if (candidate.requestedUrl && navigationKey(intendedUrl) !== navigationKey(candidate.requestedUrl)) {
      delete state.pendingChecks[triggerId];
      await saveState();
      return { ok: true, closed: 0 };
    }
    const key = duplicateKey(trigger);
    if (!key) { await saveState(); return { ok: true, closed: 0 }; }
    delete state.pendingChecks[triggerId]; // Exactly one completed navigation.
    await saveState();
    candidates = index.matching(key);
  }
  let closed = 0;
  for (const { keeper, loser } of providedPairs || duplicatePairs(candidates, state.order)) {
    if(triggerId !== null && !automaticEnabled) break;
    if (triggerId !== null && keeper.id !== triggerId && loser.id !== triggerId) continue;
    if(triggerId!==null) {
      const review=await reviewProtection(chrome,await chrome.tabs.query({windowId:loser.windowId}));
      if(review.admitted.has(loser.id))continue;
    }
    // Revalidate immediately before closing: tabs may navigate during a scan.
    const [liveKeeper, liveLoser] = await Promise.all([getTab(keeper.id), getTab(loser.id)]);
    if (!liveKeeper || !liveLoser || duplicateKey(liveKeeper) !== duplicateKey(keeper) ||
        duplicateKey(liveLoser) !== duplicateKey(keeper) ||
        liveLoser.pinned !== loser.pinned || liveKeeper.pinned !== keeper.pinned) continue;
    const entry = { at: Date.now(), title: loser.title || loser.url, url: loser.url,
      reason: triggerId === null ? globalThis.atelierI18n.t("ui_manual_cleanup_ee815c") : globalThis.atelierI18n.t("ui_new_tab_with_the_same_url_youtube_video_without_time_af6740"),
      outcome: "angefordert", keptTabId: keeper.id };
    state.closeLog = [entry, ...state.closeLog].slice(0, 20);
    await saveState(); // If recording fails, fail safely without closing a tab.
    const [finalKeeper, finalLoser] = await Promise.all([getTab(keeper.id), getTab(loser.id)]);
    if ((triggerId !== null && !automaticEnabled) || !finalKeeper || !finalLoser || duplicateKey(finalKeeper) !== duplicateKey(keeper) ||
        duplicateKey(finalLoser) !== duplicateKey(keeper) || finalKeeper.pinned !== keeper.pinned ||
        finalLoser.pinned !== loser.pinned) {
      entry.outcome = "übersprungen";
      await saveState();
      continue;
    }
    try {
      await chrome.tabs.remove(loser.id);
      index.remove(loser.id);
      entry.outcome = "geschlossen";
    } catch (error) {
      entry.outcome = "fehlgeschlagen";
      await saveState();
      throw error;
    }
    await saveState();
    closed++;
  }
  return { ok: true, closed };
}

function validateScope(payload) {
  validateWindowId(payload.windowId);
}
function domainFilter(payload) {
  if(payload.domains!==undefined && (payload.type!=='domain-window'||!Array.isArray(payload.domains)||!payload.domains.length))
    throw Error(globalThis.atelierI18n.t("ui_invalid_domain_f8ac0a"));
  const names=new Set(payload.domains??[payload.domain]);
  if([...names].some(name=>typeof name!=='string'||!name.length||name.length>512))
    throw Error(globalThis.atelierI18n.t("ui_invalid_domain_f8ac0a"));
  return tab=>{
    const host=domainOf(tab);
    if(names.has(host))return true;
    if(!payload.includeSubdomains || !/^https?:/.test(tabParkerTarget(tabUrl(tab))||tabUrl(tab)))return false;
    const labels=host.split('.');
    for(let offset=1;offset<labels.length;offset++)if(names.has(labels.slice(offset).join('.')))return true;
    return false;
  };
}
function selectedTabs(tabs, payload) {
  const matches=domainFilter(payload);
  return tabs.filter(tab => (payload.windowId === undefined || tab.windowId === payload.windowId) &&
    matches(tab));
}
async function groupDomainTabs(payload) {
  validateScope(payload);
  if (typeof payload.domain !== "string" || !payload.domain || payload.domain.length > 512) {
    throw Error(globalThis.atelierI18n.t("ui_invalid_domain_f8ac0a"));
  }
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title || title.length > 80) throw Error(globalThis.atelierI18n.t("domainGroupInvalid"));

  const tabs = selectedTabs(await chrome.tabs.query({windowType:"normal"}), payload);
  const key = groupNameKey(title);
  const shared = new Set((await chrome.tabGroups.query({})).filter(group => group.shared).map(group => group.id));
  const byWindow = new Map();
  for (const tab of tabs) {
    if (tab.pinned || tab.pendingUrl && tab.pendingUrl !== tab.url) continue;
    if (shared.has(tab.groupId)) continue;
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  const journalKey = "domainGroupNamesV1";
  const pending = (await chrome.storage.session.get(journalKey))[journalKey] || {};
  const liveGroupIds = new Set((await chrome.tabGroups.query({})).map(group=>String(group.id)));
  for(const id of Object.keys(pending))if(!liveGroupIds.has(id))delete pending[id];
  const results=[];
  let count=0;
  for(const [windowId,members] of byWindow){
    let grouped=0;
    try{
      const groups=await chrome.tabGroups.query({windowId});
      const candidate=groups.find(group=>!group.shared&&!group.title&&pending[group.id]?.windowId===windowId&&
        pending[group.id]?.domain===payload.domain&&pending[group.id]?.title===title&&members.some(tab=>tab.groupId===group.id));
      if(candidate){
        await chrome.tabGroups.update(candidate.id,{title,color:"blue"});
        delete pending[candidate.id];
        await chrome.storage.session.set({[journalKey]:pending});
      }
      const existing=candidate||groups.filter(group=>!group.shared&&groupNameKey(group.title)===key).sort((a,b)=>a.id-b.id)[0];
      const protectedIds=new Set(groups.filter(group=>group.shared).map(group=>group.id));
      const live=await Promise.all(members.map(async snapshot=>{
        const tab=await chrome.tabs.get(snapshot.id).catch(()=>null);
        return tab&&!tab.pinned&&tab.windowId===windowId&&tab.groupId===snapshot.groupId&&!protectedIds.has(tab.groupId)&&
          tab.url===snapshot.url&&(!tab.pendingUrl||tab.pendingUrl===tab.url)?tab:null;
      }));
      const current=live.filter(Boolean);
      const tabIds=current.filter(tab=>tab.groupId!==existing?.id).map(tab=>tab.id);
      grouped=current.length-tabIds.length;
      if(tabIds.length){
        const groupId=await chrome.tabs.group(existing?{tabIds,groupId:existing.id}:{tabIds,createProperties:{windowId}});
        grouped=current.length;
        if(!existing){
          pending[groupId]={windowId,domain:payload.domain,title};
          await chrome.storage.session.set({[journalKey]:pending});
          await chrome.tabGroups.update(groupId,{title,color:"blue"});
          delete pending[groupId];
          await chrome.storage.session.set({[journalKey]:pending});
        }
      }
      results.push({windowId,count:grouped});
    }catch(error){
      results.push({windowId,count:grouped,error:error.message});
    }
    count+=grouped;
  }
  const failed=results.some(result=>result.error);
  return {ok:true,title,count,skipped:tabs.length-count,...(failed?{windows:results}:{})};
}

async function domainStep(job, ctx) {
  const p = job.payload;
  const matches=domainFilter(p);
  if (!job.prepared) {
    validateScope(p);
    await index.refresh();
    const tabs = selectedTabs(await ensureIndex(), p).sort((a,b) => Number(a.incognito)-Number(b.incognito) || Number(b.pinned)-Number(a.pinned) || a.windowId-b.windowId || a.index-b.index);
    const nativeGroups=new Map();
    if(job.type==='domain-window')for(const tab of tabs)if(isGrouped(tab)&&!nativeGroups.has(tab.groupId)){
      try{const group=await chrome.tabGroups.get(tab.groupId);nativeGroups.set(tab.groupId,{key:group.id,title:group.title,color:group.color,collapsed:group.collapsed})}
      catch(error){throw Error(globalThis.atelierI18n.t("ui_could_not_read_the_tab_group_no_tabs_have_been_moved_51fd79", [error.message]))}
    }
    await ctx.write(tabs.map(({id,url,pendingUrl,pinned,incognito,windowId,groupId}) => ({id,url,pendingUrl,pinned,incognito,windowId,
      ...(nativeGroups.has(groupId)?{nativeGroup:nativeGroups.get(groupId)}:{})})));
    job.prepared = true; job.total = tabs.length; job.destinations = {}; job.count = 0;
  }
  const selected = await ctx.read();
  if(job.type==='domain-window') {
    // An older interrupted domain action may still carry its former cap.
    if(job.transfer?.maxTabsPerWindow!==undefined&&job.transfer.maxTabsPerWindow!==null){job.transfer.maxTabsPerWindow=null;await ctx.checkpoint()}
    const registered=await domainWindowTargets(chrome);

    const done=await transferStep(job,ctx,selected,{matches:(tab,original)=>
      tabUrl(tab)===tabUrl(original) && !!tab.incognito===!!original.incognito && matches(tab),
      destinationMatches:matches,groupForRecord:record=>record.nativeGroup||null,
      onMoved:async id=>{
        const tab=await getTab(id);
        if(tab&&(!p.domains||p.domains.length===1)&&registered[domainContext(tab)]!==tab.windowId){
          await rememberDomainWindow(chrome,tab.windowId,tab);registered[domainContext(tab)]=tab.windowId;
        }
        await index.refreshTab(id);
      }});
    await publish();return done;
  }
  job.phase = job.type === "domain-close" ? globalThis.atelierI18n.t("ui_closing_tabs_f7357c") : globalThis.atelierI18n.t("ui_moving_tabs_f721b2");
  for (const original of selected.slice(job.cursor, job.cursor + 20)) {
    if (ctx.cancelled()) break;
    let tab = await getTab(original.id);
    if (tab && canCloseYouTubeSource(tabUrl(tab)) && tab.windowId === original.windowId && tabUrl(tab) === tabUrl(original) && domainMatches(tab, p.domain, p.includeSubdomains)) {
      await ctx.effect(async () => {
        tab = await getTab(original.id);
        if (!tab || !canCloseYouTubeSource(tabUrl(tab)) || tab.windowId !== original.windowId || tabUrl(tab) !== tabUrl(original) || !domainMatches(tab,p.domain,p.includeSubdomains)) {
          job.cursor++;job.processed=job.cursor;return;
        }
        await chrome.tabs.remove(tab.id); index.remove(tab.id);
        job.count++;
        job.cursor++; job.processed = job.cursor;
      });
    } else { job.cursor++; job.processed = job.cursor; }
  }
  await publish();
  if (job.cursor < selected.length) return false;
  job.result = {ok:true,count:job.count,windowsCreated:Object.keys(job.destinations).length,skipped:selected.length-job.count};
  return true;
}
async function sortStep(job, ctx) {
  const {windowId,dissolveGroups} = job.payload;
  if (!Number.isInteger(windowId) || windowId < 0 || typeof dissolveGroups !== "boolean") throw Error(globalThis.atelierI18n.t("ui_could_not_identify_the_window_to_sort_fc2418"));
  if (!job.prepared) {
    await index.refresh();
    const all = await ensureIndex();
    const tabs = all.filter(t=>t.windowId===windowId);
    if (!tabs.length) throw Error(globalThis.atelierI18n.t("ui_this_window_is_no_longer_open_87f6c8"));
    const plan = windowSortPlan(tabs,state.order,dissolveGroups,job.type==="sort-window-domain");
    const expected = plan.flatMap(b=>b.tabs);
    const starts = {}; let position=0;
    for(const block of plan) { if(block.groupId !== null) starts[position]=block.groupId; position+=block.tabs.length; }
    await ctx.write({expected,starts});
    job.total=tabs.length;job.estimated=tabs.filter(t=>state.openedAt[t.id]==null).length;
    job.grouped=Object.keys(starts).length>0;job.prepared=true;
  }
  const {expected,starts}=await ctx.read();
  job.phase=globalThis.atelierI18n.t(job.type==="sort-window-domain"?"sortDomainOrder":"ui_sort_oldest_newest_acb08f");
  for (let end=Math.min(job.cursor+20,expected.length);job.cursor<end;) {
    if(ctx.cancelled()) break;
    const original=expected[job.cursor],live=await getTab(original.id);
    if(!live || live.windowId!==windowId || live.pinned!==original.pinned || (!dissolveGroups && live.groupId!==original.groupId)) throw Error(globalThis.atelierI18n.t("ui_tabs_changed_while_sorting_completed_steps_are_prese_b79e57"));
    await ctx.effect(async()=>{
      const checked=await getTab(original.id);
      if(!checked || checked.windowId!==windowId || checked.pinned!==original.pinned || (!dissolveGroups && checked.groupId!==original.groupId)) throw Error(globalThis.atelierI18n.t("ui_tabs_changed_while_sorting_c6495e"));
      if(dissolveGroups && checked.groupId>=0) await chrome.tabs.ungroup([live.id]);
      if(starts[job.cursor]!==undefined) await chrome.tabGroups.move(starts[job.cursor],{index:job.cursor});
      const current=await getTab(live.id);
      if(!current || current.windowId!==windowId) throw Error(globalThis.atelierI18n.t("ui_a_tab_was_moved_while_sorting_e647bc"));
      if(current.index!==job.cursor) await chrome.tabs.move(live.id,{index:job.cursor});
      job.cursor++;job.processed=job.cursor;
    });
  }
  if(job.cursor<expected.length)return false;
  const actual=(await chrome.tabs.query({windowId})).sort((a,b)=>a.index-b.index);
  if(actual.length!==expected.length || actual.some((tab,i)=>tab.id!==expected[i].id || tab.pinned!==expected[i].pinned || (!dissolveGroups && tab.groupId!==expected[i].groupId))) throw Error(globalThis.atelierI18n.t("ui_the_order_changed_during_the_action_please_sort_agai_ca71f8"));
  job.result={ok:true,count:expected.length,estimated:job.estimated,grouped:job.grouped};
  return true;
}
async function duplicateStep(job,ctx) {
  if(!job.prepared) {
    await index.refresh();await ensureIndex();
    const pairs=duplicatePairs(await index.snapshot(),state.order);
    await ctx.write(pairs);job.total=pairs.length;job.prepared=true;job.closed=0;
  }
  const pairs=await ctx.read();job.phase=globalThis.atelierI18n.t("ui_checking_duplicates_a13d94");
  for(const pair of pairs.slice(job.cursor,job.cursor+10)) {
    if(ctx.cancelled())break;
    await ctx.effect(async()=>{
      const result=await reconcile(null,[pair]);job.closed+=result.closed;job.cursor++;job.processed=job.cursor;
    });
  }
  await publish();
  if(job.cursor<pairs.length)return false;
  job.result={ok:true,closed:job.closed};return true;
}
tasks.register("domain-window",domainStep);
tasks.register("domain-close",domainStep);
tasks.register("sort-window-oldest",sortStep);
tasks.register("sort-window-domain",sortStep);
tasks.register("deduplicate-tabs",duplicateStep);

async function flushEvents() {
  clearTimeout(flushTimer);flushTimer=null;
  const ids=[...updates];updates.clear();
  const removed=[...removals];removals.clear();
  if(!initialized)await ensureIndex();
  for(const id of removed) {delete state.order[id];delete state.openedAt[id];delete state.pendingChecks[id];}
  if(pendingCreations.size) await track(await index.snapshot());
  for(const id of ids) {
    // Most loading events cannot cause a deletion and need no scan or write.
    if(state.pendingChecks[id]) await reconcile(id);
  }
  if(removed.length)await saveState();
  if(ids.length || removed.length) await publish(false);
}
export const flushTabManagerEvents=()=>enqueue(flushEvents);
export const flushTabManagerEventsInAction=flushEvents;
function scheduleFlush() {
  if(flushTimer)return;
  flushTimer=setTimeout(()=>{flushTimer=null;enqueue(flushEvents).catch(console.warn)},60);
}

// Capture browser events synchronously; merge bursts before touching storage/UI.
chrome.tabs.onCreated.addListener(tab => {
  index.put(tab);publicationVersion++;
  const url=tabUrl(tab);
  pendingCreations.set(tab.id,{at:Date.now(),sequence:++creationSequence,requestedUrl:(/^https?:\/\//i.test(url)||tabParkerTarget(url))?url:null});
  updates.add(tab.id);scheduleFlush();
});
chrome.tabs.onUpdated.addListener((id,change,tab) => {
  if(change.url!==undefined || (tab && tabUrl(tab)!==tabUrl(index.get(id)||{})))publicationVersion++;
  if(tab) index.put(tab);
  else if(index.get(id)) index.put({...index.get(id),...change});
  if(change.url!==undefined || change.status==="complete") {updates.add(id);scheduleFlush();}
});
chrome.tabs.onRemoved.addListener(id=>{index.remove(id);publicationVersion++;pendingCreations.delete(id);removals.add(id);scheduleFlush()});
chrome.tabs.onAttached?.addListener((id,info)=>{
  const tab=index.get(id);publicationVersion++;
  if(tab)index.put({...tab,windowId:info.newWindowId,index:info.newPosition});
  updates.add(id);scheduleFlush();
});
chrome.tabs.onReplaced.addListener((added,removed)=>{
  enqueue(async()=>{
    if(!state)state=(await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
    if(state?.order[removed]!==undefined){state.order[added]=state.order[removed];state.openedAt??={};state.openedAt[added]=state.openedAt[removed]??null;}
    index.remove(removed);await index.refreshTab(added);await track(await index.snapshot());initialized=true;
    delete state.pendingChecks[added];await saveState();await publish();
  }).catch(console.warn);
});
async function initializeSession(startup=false) {
  await index.refresh();await ensureIndex();state.pendingChecks={};
  if(startup)state.autoGraceUntil=Date.now()+STARTUP_GRACE_MS;
  await saveState();await publish();
}
chrome.runtime.onInstalled.addListener(()=>{enqueue(()=>initializeSession()).catch(console.warn)});
chrome.runtime.onStartup.addListener(()=>{enqueue(()=>initializeSession(true)).catch(console.warn)});
const messages=new Set(["get-dashboard-tabs","open-dashboard","open-donate","focus-dashboard-tab","get-domains","domain-window","domain-close","domain-group","deduplicate-tabs","sort-window-oldest","sort-window-domain","set-automatic-duplicates"]);
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(!messages.has(message?.type))return false;
  if(!isTrustedPage(sender)) {
    reply({ok:false,error:globalThis.atelierI18n.t("ui_unauthorized_message_source_674efb")});return false;
  }
  // A pause takes effect immediately, even while another job owns the queue.
  if(message.type==="set-automatic-duplicates" && message.enabled===false) {automaticEnabled=false;settingsLoaded=true;}
  const action=async()=>{
    if(["domain-window","domain-close","deduplicate-tabs","sort-window-oldest","sort-window-domain"].includes(message.type)) {
      await enqueue(flushEvents);
      return tasks.start(message.type,message,message.type.startsWith("domain-")?(message.domain||globalThis.atelierI18n.t("domainMoveSelected")):message.type==="deduplicate-tabs"?globalThis.atelierI18n.t("ui_clean_up_duplicates_eb1066"):globalThis.atelierI18n.t("ui_sort_window_c2f810"));
    }
    return enqueue(async()=>{
      await flushEvents();await loadAutoSetting();
      if(message.type==="open-dashboard" || message.type==="open-donate") {
        const url=chrome.runtime.getURL(message.type==="open-donate"?"donate.html":"dashboard.html");
        const existing=(await chrome.tabs.query({url})).find(tab=>tab.url===url);
        if(!existing)await assertTabCapacity(chrome);
        const tab=existing ? await chrome.tabs.update(existing.id,{active:true}) : await chrome.tabs.create({url});
        await chrome.windows.update(tab.windowId,{focused:true});
        return {ok:true};
      }
      if(message.type==="focus-dashboard-tab") {
        if(!Number.isInteger(message.tabId))throw Error(globalThis.atelierI18n.t("ui_invalid_tab_3edee0"));
        const tab=await chrome.tabs.get(message.tabId);
        await chrome.tabs.update(tab.id,{active:true});
        await chrome.windows.update(tab.windowId,{focused:true});
        return {ok:true};
      }
      if(message.type==="get-dashboard-tabs") {
        const tabs=await index.snapshot();
        return {ok:true,tabs:tabs.map(tab=>({id:tab.id,windowId:tab.windowId,index:tab.index,
          title:parseYouTubeTab(tabUrl(tab))?.title||tab.title||tabUrl(tab),url:tabUrl(tab),domain:domainOf(tab),pinned:!!tab.pinned,incognito:!!tab.incognito}))};
      }
      if(message.type==="domain-group") return groupDomainTabs(message);
      if(message.type==="get-domains") {
        const all=await index.snapshot();validateScope(message);
        const tabs=all.filter(t=>message.windowId===undefined || t.windowId===message.windowId);
        const settings=await readTabSettings(chrome);
        const {markerTabs,protectedTabs}=await reviewProtection(chrome,all);
        const totalCount=all.filter(tab=>!markerTabs.has(tab.id)&&!isLimitPage(chrome,tab)).length;
        const videoCount=all.filter(tab=>!tab.incognito&&!protectedTabs.has(tab.id)&&parseYouTubeTab(tabUrl(tab))).length;
        return {ok:true,totalCount,videoCount,totalCap:settings.totalLimitEnabled?settings.totalLimit:null,
          videoCap:settings.youtubeLimitEnabled?settings.youtubeLimit:null,total:all.length,scopeTotal:tabs.length,domains:domainSummary(tabs,message.includeSubdomains),automaticEnabled,closeLog:state.closeLog};
      }
      if(typeof message.enabled!=="boolean")throw Error(globalThis.atelierI18n.t("ui_invalid_setting_144cc6"));
      await chrome.storage.local.set({[AUTO_KEY]:message.enabled});automaticEnabled=message.enabled;settingsLoaded=true;
      state.pendingChecks={};await saveState();return {ok:true,automaticEnabled};
    });
  };
  action().then(reply,error=>reply({ok:false,error:error.message || globalThis.atelierI18n.t("ui_action_failed_028a4a")}));return true;
});
