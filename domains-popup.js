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

function renderDomains() {
  const filter = domainSearch.value.trim().toLowerCase();
  const rows = domains.filter(item => item.domain.toLowerCase().includes(filter));
  domainList.replaceChildren();
  for (const item of rows) {
    const row = document.createElement("li");
    row.className = "channel-item";
    const label = document.createElement("span");
    label.className = "channel-name";
    label.textContent = `${globalThis.atelierI18n.label(item.domain)} (${item.count})`;
    label.title = label.textContent;
    row.append(label);
    for (const action of ["window", "group", "close"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `row-button ${action === "close" ? "close-button" : "move-button"}`;
      button.textContent = globalThis.atelierI18n.t({window:'actionWindow',close:'actionClose',group:'actionGroup'}[action]);
      button.dataset.domain = item.domain;
      button.dataset.action = action;
      button.disabled = domainBusy;
      button.setAttribute("aria-label", globalThis.atelierI18n.t("ui_tabs_from_04f5ab", [item.count, item.domain, action === "group" ? globalThis.atelierI18n.t("actionGroup") : action === "close" ? globalThis.atelierI18n.t("ui_close_e0b9f0") : globalThis.atelierI18n.t("ui_collect_in_a_new_window_with_no_per_window_tab_limit_dc3187")]));
      row.append(button);
    }
    domainList.append(row);
  }
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "section-copy";
    empty.textContent = globalThis.atelierI18n.t("ui_no_matching_domains_10a591");
    domainList.append(empty);
  }
}

async function refreshDomains() {
  const request = ++domainRequest;
  try {
    const result = await domainMessage("get-domains",await scope());
    if (request !== domainRequest) return;
    domains = result.domains;
    document.getElementById("domainScopeLabel").textContent=domainCurrentWindow.checked?globalThis.atelierI18n.t("ui_this_window_e8cb28"):globalThis.atelierI18n.t("ui_all_windows_7d53f7");
    totalTabs.textContent = String(result.total);
    totalTabs.setAttribute("aria-label", globalThis.atelierI18n.t("ui_open_tabs_dfe13d", [result.total]));
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
    if (domainStatus.textContent === globalThis.atelierI18n.t("ui_loading_domains_1d34f4")) domainFeedback(globalThis.atelierI18n.t("ui_domains_tabs_selected_eb1429", [domains.length, result.scopeTotal]));
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

domainCurrentWindow.addEventListener("change",()=>{domainFeedback(globalThis.atelierI18n.t("ui_loading_domains_1d34f4"));refreshDomains()});
domainSubdomains.addEventListener("change",()=>{domainFeedback(globalThis.atelierI18n.t("ui_loading_domains_1d34f4"));refreshDomains()});
const cacheDetails=document.getElementById("cacheDetails"),cacheStatus=document.getElementById("cacheStatus");
async function refreshCache() {
  try{const result=await domainMessage("metadata-cache-stats");cacheStatus.textContent=globalThis.atelierI18n.t("ui_videos_kb_stored_2fa94d", [result.entries, result.maxEntries, (result.bytes/1024).toFixed(1)]);}catch(error){cacheStatus.textContent=error.message;}
}
cacheDetails.addEventListener("toggle",()=>{if(cacheDetails.open)refreshCache()});
document.getElementById("clearMetadataCache").addEventListener("click",async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{await domainMessage("metadata-cache-clear");await refreshCache();}catch(error){cacheStatus.textContent=error.message;}finally{button.disabled=false;}
});
