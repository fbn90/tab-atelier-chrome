const domainList = document.getElementById("domainList");
const domainSearch = document.getElementById("domainSearch");
const domainStatus = document.getElementById("domainStatus");
const totalTabs = document.getElementById("totalTabs");
const deduplicateButton = document.getElementById("deduplicateButton");
const sortWindowButton = document.getElementById("sortWindowButton");
const sortWindowStatus = document.getElementById("sortWindowStatus");
const automaticDuplicates = document.getElementById("automaticDuplicates");
const duplicateCloseLog = document.getElementById("duplicateCloseLog");
let autoSettingBusy = false;
// Capture the popup's own window now; focus may change while work is queued.
const popupWindowId = chrome.windows.getCurrent().then(window => window.id, () => null);
const domainCurrentWindow=document.getElementById("domainCurrentWindow");
const domainSubdomains=document.getElementById("domainSubdomains");
async function scope() {
  const windowId=domainCurrentWindow.checked?await popupWindowId:undefined;
  if(domainCurrentWindow.checked && windowId===null)throw Error(globalThis.atelierI18n.t("ui_could_not_identify_the_window_c6032f"));
  return {windowId,includeSubdomains:domainSubdomains.checked};
}
let domains = [];
const domainSelection=new Set();
const moveSelected=document.getElementById("moveSelected");
const selectionBar=document.getElementById("selectionBar");
const updateSelection=()=>{
  selectionBar.hidden=!domainSelection.size||document.getElementById("organizePane").hidden;
  moveSelected.disabled=domainBusy||!domainSelection.size;
  moveSelected.textContent=globalThis.atelierI18n.t(domainSelection.size===1?"popupMoveOne":"popupMoveMany",[domainSelection.size]);
};
let domainBusy = false;
let domainRefreshTimer;
let domainRequest = 0;

function domainFeedback(text, error = false) {
  domainStatus.textContent = text;
  domainStatus.classList.toggle("error", error);
}

async function domainMessage(type, payload = {}) {
  const result = await window.atelierTasks.send(type, payload);
  if (!result?.ok) throw new Error(result?.error || globalThis.atelierI18n.t("ui_could_not_connect_to_the_extension_6ecfcb"));
  return result;
}

const rowsByDomain=new Map();
let expandedDomain=null;
let rowSequence=0;
const emptyDomainRow=document.createElement("li");
emptyDomainRow.className="section-copy";
emptyDomainRow.textContent=globalThis.atelierI18n.t("ui_no_matching_domains_10a591");

function setExpanded(domain) {
  const previous=rowsByDomain.get(expandedDomain);
  if(previous){previous.actions.hidden=true;previous.toggle.setAttribute("aria-expanded","false")}
  expandedDomain=domain;
  const next=rowsByDomain.get(domain);
  if(next){
    next.actions.hidden=false;next.toggle.setAttribute("aria-expanded","true");
    next.row.scrollIntoView({block:"nearest"});
  }
}

function makeDomainRow(domain){
  const t=globalThis.atelierI18n.t;
  const row=document.createElement("li"),identity=document.createElement("div");
  row.className="domain-row";identity.className="domain-identity";
  const id="domain-"+(++rowSequence);
  const checkbox=document.createElement("input"),label=document.createElement("label"),count=document.createElement("span");
  checkbox.id=id;checkbox.type="checkbox";checkbox.setAttribute("aria-label",t("domainSelect",[domain]));
  label.htmlFor=id;label.textContent=globalThis.atelierI18n.label(domain);label.title=label.textContent;
  count.className="domain-count";identity.append(label,count);
  checkbox.addEventListener("change",()=>{
    if(checkbox.checked)domainSelection.add(domain);else domainSelection.delete(domain);
    updateSelection();
  });
  function actionButton(action,key){
    const button=document.createElement("button");
    button.type="button";button.dataset.domain=domain;button.dataset.action=action;
    button.className="row-button"+(action==="close"?" close-button":"");
    button.textContent=t(key);
    return button;
  }
  const windowButton=actionButton("window","actionWindow"),group=actionButton("group","popupGroup"),close=actionButton("close","popupClose");
  const toggle=document.createElement("button"),actions=document.createElement("div");
  toggle.type="button";toggle.className="row-button domain-toggle";toggle.textContent="•••";
  toggle.setAttribute("aria-label",t("domainMore",[domain]));
  toggle.setAttribute("aria-expanded","false");toggle.setAttribute("aria-controls",id+"-actions");
  toggle.addEventListener("click",()=>setExpanded(expandedDomain===domain?null:domain));
  actions.className="domain-actions";actions.id=id+"-actions";actions.hidden=true;
  actions.append(group,close);row.append(checkbox,identity,windowButton,toggle,actions);
  return {row,checkbox,count,toggle,actions,windowButton,group,close};
}

document.addEventListener("keydown",event=>{
  if(event.key!=="Escape"||!expandedDomain||document.getElementById("organizePane").hidden||document.querySelector("dialog[open]"))return;
  const trigger=rowsByDomain.get(expandedDomain)?.toggle;
  event.preventDefault();event.stopPropagation();setExpanded(null);trigger?.focus();
});

function renderDomains() {
  const filter=domainSearch.value.trim().toLowerCase();
  const visible=domains.filter(item=>item.domain.toLowerCase().includes(filter));
  const names=new Set(visible.map(item=>item.domain));
  const focused=document.activeElement,focusedRow=focused?.closest(".domain-row");
  const scroller=document.getElementById("popupContent");
  const scrollerBounds=scroller.getBoundingClientRect();
  const oldTop=focusedRow?.getBoundingClientRect().top;
  const anchored=oldTop>=scrollerBounds.top&&oldTop<scrollerBounds.bottom;
  for(const domain of domainSelection)if(!names.has(domain))domainSelection.delete(domain);
  if(!names.has(expandedDomain))setExpanded(null);
  for(const [domain,view] of rowsByDomain)if(!names.has(domain)){view.row.remove();rowsByDomain.delete(domain)}
  updateSelection();
  if(!visible.length){if(!emptyDomainRow.isConnected)domainList.append(emptyDomainRow)}
  else emptyDomainRow.remove();
  let cursor=domainList.firstElementChild;
  for(const item of visible){
    let view=rowsByDomain.get(item.domain);
    if(!view){view=makeDomainRow(item.domain);rowsByDomain.set(item.domain,view)}
    if(view.lastCount!==item.count){
      view.count.textContent="("+item.count+")";
      const params=[item.count,item.domain];
      for(const [button,key] of [[view.windowButton,"popupWindowLabel"],[view.group,"popupGroupLabel"],[view.close,"popupCloseLabel"]])
        button.setAttribute("aria-label",globalThis.atelierI18n.t(item.count===1?key+"One":key,params));
      view.lastCount=item.count;
    }
    view.checkbox.checked=domainSelection.has(item.domain);
    for(const control of [view.checkbox,view.windowButton,view.group,view.close,view.toggle])control.disabled=domainBusy;
    if(view.row!==cursor){
      if(view.row.isConnected&&domainList.moveBefore)domainList.moveBefore(view.row,cursor);
      else domainList.insertBefore(view.row,cursor);
    }
    cursor=view.row.nextElementSibling;
  }
  if(focusedRow&&focused.isConnected&&!focused.disabled&&document.activeElement!==focused)focused.focus({preventScroll:true});
  if(focusedRow&&!focused.isConnected)domainSearch.focus({preventScroll:true});
  if(anchored&&focusedRow.isConnected)scroller.scrollTop+=focusedRow.getBoundingClientRect().top-oldTop;
}

async function refreshDomains() {
  const request = ++domainRequest;
  try {
    const result = await domainMessage("get-domains",await scope());
    if (request !== domainRequest) return;
    domains = result.domains;
    document.getElementById("domainScopeLabel").textContent=domainCurrentWindow.checked?globalThis.atelierI18n.t("ui_this_window_e8cb28"):globalThis.atelierI18n.t("ui_all_windows_7d53f7");
    const off=globalThis.atelierI18n.t("ui_off_2337c3");
    document.getElementById("totalMeter").textContent=globalThis.atelierI18n.t("totalMeterLabel",[result.totalCount,result.totalCap??off]);
    document.getElementById("videoMeter").textContent="YouTube "+result.videoCount+" / "+(result.videoCap??off);
    totalTabs.textContent = globalThis.atelierI18n.t(result.scopeTotal===1?"popupTabOne":"popupTabCount",[result.scopeTotal]);
    totalTabs.setAttribute("aria-label", globalThis.atelierI18n.t("ui_open_tabs_dfe13d", [result.scopeTotal]));
    renderDomains();
    if (!autoSettingBusy) {
      automaticDuplicates.checked = result.automaticEnabled;
      automaticDuplicates.disabled = false;
    }
    duplicateCloseLog.replaceChildren();
    for (const entry of result.closeLog || []) {
      const item = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = `${new Date(entry.at).toLocaleTimeString(globalThis.atelierI18n.locale)} · ${globalThis.atelierI18n.label(entry.outcome)}: ${entry.title} – ${entry.reason}`;
      text.title = entry.url;
      item.append(text);
      duplicateCloseLog.append(item);
    }
    if (!duplicateCloseLog.children.length) {
      const empty = document.createElement("li");
      empty.textContent = globalThis.atelierI18n.t("ui_no_actions_recorded_yet_2da3c0");
      duplicateCloseLog.append(empty);
    }
    if (domainStatus.textContent === globalThis.atelierI18n.t("ui_loading_domains_1d34f4")) domainFeedback("");
  } catch (error) { domainFeedback(error.message, true); }
}

async function runDomainAction(type, payload = {}) {
  if (domainBusy) return;
  domainBusy = true;
  deduplicateButton.disabled = true;
  renderDomains();
  domainFeedback(globalThis.atelierI18n.t("ui_working_330f60"));
  try {
    const result = await domainMessage(type, payload);
    domainFeedback(type === "domain-group" ? window.atelierDomainGroupFeedback(result) : type === "deduplicate-tabs" ? globalThis.atelierI18n.t("ui_duplicates_closed_987d56", [result.closed]) :
      globalThis.atelierI18n.t("ui_tabs_da90fb", [result.count, type === "domain-close" ? globalThis.atelierI18n.t("ui_closed_da731d") : globalThis.atelierI18n.t("ui_moved_to_new_windows_793514", [result.windowsCreated]), result.warningCount?globalThis.atelierI18n.t("ui_see_the_task_list_for_details_d378c1"):""]));
  } catch (error) { domainFeedback(error.message, true); }
  finally {
    domainBusy = false;
    deduplicateButton.disabled = false;
    await refreshDomains();
  }
}

document.getElementById("sortDomainOrder").addEventListener("click",async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{
    const result=await domainMessage("sort-window-domain",{windowId:await popupWindowId,dissolveGroups:false});
    domainFeedback(globalThis.atelierI18n.t("sortDomainResult",[result.count]));
  }catch(error){domainFeedback(error.message,true)}
  finally{button.disabled=false}
});
document.addEventListener("limits-changed",refreshDomains);
moveSelected.addEventListener("click",async()=>{
  try{
    const names=[...domainSelection];if(!names.length)return;
    await runDomainAction("domain-window",{domains:names,...await scope()});
  }catch(error){domainFeedback(error.message,true)}
});
domainSearch.addEventListener("input", renderDomains);
deduplicateButton.addEventListener("click", () => runDomainAction("deduplicate-tabs"));
automaticDuplicates.addEventListener("change", async () => {
  autoSettingBusy = true;
  automaticDuplicates.disabled = true;
  try {
    const result = await domainMessage("set-automatic-duplicates", { enabled: automaticDuplicates.checked });
    automaticDuplicates.checked = result.automaticEnabled;
    domainFeedback(result.automaticEnabled ? globalThis.atelierI18n.t("ui_automatic_duplicate_closing_is_on_for_newly_opened_t_2ada06") : globalThis.atelierI18n.t("ui_automatic_closing_paused_0dbaf1"));
  } catch (error) { domainFeedback(error.message, true); }
  finally { autoSettingBusy = false; await refreshDomains(); }
});
sortWindowButton.addEventListener("click", async () => {
  sortWindowButton.disabled = true;
  sortWindowStatus.classList.remove("error");
  sortWindowStatus.textContent = globalThis.atelierI18n.t("ui_sorting_a59b10");
  try {
    const result = await domainMessage("sort-window-oldest", {
      windowId: await popupWindowId,
      dissolveGroups: document.getElementById("dissolveGroups").checked
    });
    sortWindowStatus.textContent = globalThis.atelierI18n.t("ui_tabs_sorted_from_oldest_to_newest_d0a7a1", [result.count, result.grouped ? globalThis.atelierI18n.t("ui_groups_stay_together_751e2e") : "", result.estimated ? globalThis.atelierI18n.t("ui_for_tabs_the_order_is_based_on_when_they_were_first_8b97b5", [result.estimated]) : ""]);
  } catch (error) {
    sortWindowStatus.textContent = error.message;
    sortWindowStatus.classList.add("error");
  } finally { sortWindowButton.disabled = false; }
});
domainList.addEventListener("click", async event => {
  const button = event.target.closest("button[data-domain]");
  if (!button || domainBusy) return;
  const { domain, action } = button.dataset;
  try {
    const options = await scope();
    const title = action === 'group' ? await window.atelierDomainGroupName(domain) : undefined;
    if (action === 'group' && !title) return;
    await runDomainAction(`domain-${action}`, { domain, ...options, title });
  } catch (error) { domainFeedback(error.message, true); }
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== "domains-invalidated") return;
  clearTimeout(domainRefreshTimer);
  domainRefreshTimer = setTimeout(refreshDomains, 120);
});
refreshDomains();

domainCurrentWindow.addEventListener("change",()=>{domainSelection.clear();renderDomains();domainFeedback(globalThis.atelierI18n.t("ui_loading_domains_1d34f4"));refreshDomains()});
domainSubdomains.addEventListener("change",()=>{domainSelection.clear();renderDomains();domainFeedback(globalThis.atelierI18n.t("ui_loading_domains_1d34f4"));refreshDomains()});
const cacheDetails=document.getElementById("cacheDetails"),cacheStatus=document.getElementById("cacheStatus");
async function refreshCache() {
  try{const result=await domainMessage("metadata-cache-stats");cacheStatus.textContent=globalThis.atelierI18n.t("ui_videos_kb_stored_2fa94d", [result.entries, result.maxEntries, (result.bytes/1024).toFixed(1)]);}catch(error){cacheStatus.textContent=error.message;}
}
cacheDetails.addEventListener("toggle",()=>{if(cacheDetails.open)refreshCache()});
document.getElementById("clearMetadataCache").addEventListener("click",async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{await domainMessage("metadata-cache-clear");await refreshCache();}catch(error){cacheStatus.textContent=error.message;}finally{button.disabled=false;}
});
