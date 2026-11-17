const MESSAGE_TYPES = Object.freeze({
  EXPORT_WATCH_TABS: "export-watch-tabs",
  GET_GROUP_ACTIONS: "get-group-actions",
  MOVE_GROUP_TO_WINDOW: "move-group-to-window",
  CLOSE_GROUP_TABS: "close-group-tabs",
  GET_SETTINGS: "get-settings",
  SET_CHANNEL_THRESHOLD: "set-channel-threshold",
  GROUPS_INVALIDATED: "groups-invalidated"
});

const GROUP_BY = Object.freeze({
  CHANNEL: "channel",
  TOPIC: "topic"
});

const PARTIAL_REFRESH_MS = 200;
const INVALIDATION_REFRESH_DEBOUNCE_MS = 250;
const DEFAULT_CHANNEL_ACTION_MIN_COUNT = 2;
const MAX_CHANNEL_ACTION_MIN_COUNT = 999;

const UI = Object.freeze({
  runButton: document.getElementById("runButton"),
  refreshChannelsButton: document.getElementById("refreshChannelsButton"),
  saveThresholdButton: document.getElementById("saveThresholdButton"),
  thresholdInput: document.getElementById("thresholdInput"),
  thresholdPreview: document.getElementById("thresholdPreview"),
  groupModeLabel: document.getElementById("groupModeLabel"),
  groupModeTitle: document.getElementById("groupModeTitle"),
  modeChannelButton: document.getElementById("modeChannelButton"),
  modeTopicButton: document.getElementById("modeTopicButton"),
  channelFilterText: document.getElementById("channelFilterText"),
  channelList: document.getElementById("channelList"),
  channelEmpty: document.getElementById("channelEmpty"),
  channelStatus: document.getElementById("channelStatus"),
  status: document.getElementById("status"),
  details: document.getElementById("details")
});

let groupLoadPromise = null;
let partialRefreshTimer = null;
let invalidationRefreshTimer = null;
let channelActionMinCount = DEFAULT_CHANNEL_ACTION_MIN_COUNT;
let activeGroupBy = GROUP_BY.CHANNEL;
let suppressInvalidationRefreshUntil = 0;

function setStatus(message, isError = false) {
  UI.status.textContent = message;
  UI.status.classList.toggle("error", isError);
}

function setChannelStatus(message, isError = false) {
  UI.channelStatus.textContent = message;
  UI.channelStatus.classList.toggle("error", isError);
}

function setDetails(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    UI.details.hidden = true;
    UI.details.textContent = "";
    return;
  }

  UI.details.hidden = false;
  UI.details.textContent = lines.join("\n");
}

function normalizeChannelActionMinCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHANNEL_ACTION_MIN_COUNT;
  }

  return Math.min(MAX_CHANNEL_ACTION_MIN_COUNT, Math.max(0, Math.floor(parsed)));
}

function normalizeGroupBy(value) {
  return value === GROUP_BY.TOPIC ? GROUP_BY.TOPIC : GROUP_BY.CHANNEL;
}

function clearPartialRefreshTimer() {
  if (partialRefreshTimer) {
    clearTimeout(partialRefreshTimer);
    partialRefreshTimer = null;
  }
}

function clearInvalidationRefreshTimer() {
  if (invalidationRefreshTimer) {
    clearTimeout(invalidationRefreshTimer);
    invalidationRefreshTimer = null;
  }
}

function suppressInvalidationRefresh(windowMs = 1200) {
  suppressInvalidationRefreshUntil = Date.now() + windowMs;
}

function getModeCopy(groupBy = activeGroupBy) {
  if (groupBy === GROUP_BY.TOPIC) {
    return {
      label: globalThis.atelierI18n.t("ui_youtube_by_topic_a98d90"),
      title: globalThis.atelierI18n.t("ui_clusters_c137a7"),
      nounPlural: globalThis.atelierI18n.t("ui_clusters_c137a7"),
      loading: globalThis.atelierI18n.t("ui_scanning_topics_d70495"),
      filter: globalThis.atelierI18n.t("ui_only_topics_with_more_than_tabs_858dc7", [channelActionMinCount]),
      empty: globalThis.atelierI18n.t("ui_no_topics_with_more_than_tabs_ba669e", [channelActionMinCount])
    };
  }

  return {
    label: globalThis.atelierI18n.t("ui_youtube_by_channel_bb31ab"),
    title: globalThis.atelierI18n.t("ui_channels_d459d5"),
    nounPlural: globalThis.atelierI18n.t("ui_channels_d459d5"),
    loading: globalThis.atelierI18n.t("ui_scanning_channels_c5bd18"),
    filter: globalThis.atelierI18n.t("ui_only_channels_with_more_than_tabs_193309", [channelActionMinCount]),
    empty: globalThis.atelierI18n.t("ui_no_channels_with_more_than_tabs_691722", [channelActionMinCount])
  };
}

function syncThresholdUi(value) {
  channelActionMinCount = normalizeChannelActionMinCount(value);
  const copy = getModeCopy();

  UI.thresholdInput.value = String(channelActionMinCount);
  UI.thresholdPreview.textContent = `> ${channelActionMinCount}`;
  UI.channelFilterText.textContent = copy.filter;
  UI.channelEmpty.textContent = copy.empty;
}

function syncModeUi(groupBy) {
  activeGroupBy = normalizeGroupBy(groupBy);
  document.getElementById("topicEditor").hidden = activeGroupBy !== GROUP_BY.TOPIC;
  const copy = getModeCopy(activeGroupBy);

  UI.groupModeLabel.textContent = copy.label;
  UI.groupModeTitle.textContent = copy.title;
  UI.modeChannelButton.classList.toggle("is-active", activeGroupBy === GROUP_BY.CHANNEL);
  UI.modeTopicButton.classList.toggle("is-active", activeGroupBy === GROUP_BY.TOPIC);
  UI.modeChannelButton.setAttribute(
    "aria-pressed",
    String(activeGroupBy === GROUP_BY.CHANNEL)
  );
  UI.modeTopicButton.setAttribute("aria-pressed", String(activeGroupBy === GROUP_BY.TOPIC));
  syncThresholdUi(channelActionMinCount);
}

function readThresholdInput() {
  const raw = UI.thresholdInput.value.trim();
  if (raw === "") {
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(globalThis.atelierI18n.t("ui_please_enter_a_number_greater_than_or_equal_to_0_ce901e"));
  }

  return normalizeChannelActionMinCount(parsed);
}

async function sendMessage(type, payload = {}, fallbackError = globalThis.atelierI18n.t("ui_unknown_error_617580")) {
  const response = await window.atelierTasks.send(type, payload);
  if (!response?.ok) {
    throw new Error(response?.error || fallbackError);
  }

  return response;
}

function createGroupActionRow(item) {
  const row = document.createElement("li");
  row.className = "channel-item";
  row.dataset.groupKey = item.key;
  row.dataset.groupLabel = item.label;

  const groupName = document.createElement("span");
  groupName.className = "channel-name";
  groupName.textContent = globalThis.atelierI18n.label(item.label);
  groupName.title = groupName.textContent;

  const groupCount = document.createElement("span");
  groupCount.className = "channel-count";
  groupCount.textContent = String(item.count);

  const moveButton = document.createElement("button");
  moveButton.type = "button";
  moveButton.className = "row-button move-button";
  moveButton.dataset.action = "move";
  moveButton.textContent = globalThis.atelierI18n.t("ui_window_22c978");
  moveButton.setAttribute("aria-label", globalThis.atelierI18n.t("ui_collect_in_one_group_merge_matching_groups_and_close_2193f3", [item.label]));

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "row-button close-button";
  closeButton.dataset.action = "close";
  closeButton.textContent = globalThis.atelierI18n.t("ui_close_b808f6");
  closeButton.setAttribute("aria-label", globalThis.atelierI18n.t("ui_close_tabs_from_89c01a", [item.label]));

  row.append(groupName, groupCount, moveButton, closeButton);
  return row;
}

function renderGroupActions(groups) {
  UI.channelList.textContent = "";

  if (!Array.isArray(groups) || groups.length === 0) {
    UI.channelEmpty.hidden = false;
    return;
  }

  UI.channelEmpty.hidden = true;
  for (const group of groups) {
    UI.channelList.append(createGroupActionRow(group));
  }
}

function updateGroupSummary(response) {
  if (!response) {
    return;
  }

  if (typeof response.channelActionMinCount === "number") {
    channelActionMinCount = normalizeChannelActionMinCount(response.channelActionMinCount);
  }

  syncModeUi(response.groupBy || activeGroupBy);

  const copy = getModeCopy(response.groupBy || activeGroupBy);
  const summary = `${response.resolvedTabs}/${response.matchedTabs} | ${response.groups.length} ${copy.nounPlural}`;

  if (response.isPartial) {
    setChannelStatus(globalThis.atelierI18n.t("ui_loading_more_1e2096", [summary]));
    return;
  }

  setChannelStatus(summary);
}

async function loadSettings() {
  const response = await sendMessage(
    MESSAGE_TYPES.GET_SETTINGS,
    {},
    globalThis.atelierI18n.t("ui_could_not_load_settings_456203")
  );
  channelActionMinCount = normalizeChannelActionMinCount(response.channelActionMinCount);
  syncModeUi(activeGroupBy);
  return response;
}

function schedulePartialRefresh(isPartial) {
  clearPartialRefreshTimer();
  if (!isPartial) {
    return;
  }

  partialRefreshTimer = setTimeout(async () => {
    try {
      await refreshActiveGroups("", { silentError: true, keepStatus: true });
    } catch {
      // Error handling is done in loadGroupActions.
    }
  }, PARTIAL_REFRESH_MS);
}

async function loadGroupActions({
  showLoadingStatus = false,
  silentError = false,
  keepStatus = false
} = {}) {
  if (groupLoadPromise) {
    return groupLoadPromise;
  }

  if (showLoadingStatus) {
    setChannelStatus(getModeCopy(activeGroupBy).loading);
  } else if (!keepStatus) {
    setChannelStatus(globalThis.atelierI18n.t("ui_refreshing_9fd451"));
  }

  UI.refreshChannelsButton.disabled = true;

  groupLoadPromise = (async () => {
    const response = await sendMessage(
      MESSAGE_TYPES.GET_GROUP_ACTIONS,
      { groupBy: activeGroupBy },
      globalThis.atelierI18n.t("ui_could_not_load_groups_431aa3")
    );
    renderGroupActions(response.groups);
    if (activeGroupBy === GROUP_BY.TOPIC) updateTopicChoices(response.topicChoices || []);
    updateGroupSummary(response);
    schedulePartialRefresh(Boolean(response.isPartial));
    return response;
  })()
    .catch((error) => {
      if (!silentError) {
        setChannelStatus(error?.message || globalThis.atelierI18n.t("ui_could_not_load_groups_431aa3"), true);
      }
      throw error;
    })
    .finally(() => {
      UI.refreshChannelsButton.disabled = false;
      groupLoadPromise = null;
    });

  return groupLoadPromise;
}

async function refreshActiveGroups(
  statusMessage = globalThis.atelierI18n.t("ui_refreshing_9fd451"),
  { silentError = false, keepStatus = false } = {}
) {
  if (statusMessage) {
    setChannelStatus(statusMessage);
  }

  return loadGroupActions({
    showLoadingStatus: false,
    silentError,
    keepStatus: keepStatus || Boolean(statusMessage)
  });
}

function scheduleInvalidatedRefresh() {
  if (Date.now() < suppressInvalidationRefreshUntil) {
    return;
  }

  clearInvalidationRefreshTimer();
  invalidationRefreshTimer = setTimeout(async () => {
    try {
      await refreshActiveGroups("", { silentError: true, keepStatus: false });
    } catch {
      // Error handling is done in loadGroupActions.
    }
  }, INVALIDATION_REFRESH_DEBOUNCE_MS);
}

async function saveThreshold() {
  UI.saveThresholdButton.disabled = true;
  setChannelStatus(globalThis.atelierI18n.t("ui_saving_196132"));

  try {
    const nextValue = readThresholdInput();
    suppressInvalidationRefresh();
    const response = await sendMessage(
      MESSAGE_TYPES.SET_CHANNEL_THRESHOLD,
      { channelActionMinCount: nextValue },
      globalThis.atelierI18n.t("ui_could_not_save_the_threshold_74ac9e")
    );
    channelActionMinCount = normalizeChannelActionMinCount(response.channelActionMinCount);
    syncModeUi(activeGroupBy);
    await refreshActiveGroups("", { keepStatus: false });
  } catch (error) {
    setChannelStatus(error?.message || globalThis.atelierI18n.t("ui_could_not_save_the_threshold_74ac9e"), true);
  } finally {
    UI.saveThresholdButton.disabled = false;
  }
}

async function handleMoveGroup(groupKey, groupLabel, button) {
  button.disabled = true;
  setStatus(globalThis.atelierI18n.t("ui_moving_090cad", [groupLabel]));

  try {
    suppressInvalidationRefresh();
    const response = await sendMessage(
      MESSAGE_TYPES.MOVE_GROUP_TO_WINDOW,
      {
        groupBy: activeGroupBy,
        groupKey
      },
      globalThis.atelierI18n.t("ui_could_not_move_the_group_a68314")
    );

    const windowsPart =
      response.windowsCreated > 0 ? globalThis.atelierI18n.t("ui_in_windows_5d6096", [response.windowsCreated]) : "";
    const groupPart = response.groupedTabs ? globalThis.atelierI18n.t("ui_grouped_360adf", [response.groupedTabs]) : "";
    setStatus(globalThis.atelierI18n.t("ui_tabs_from_processed_f4cf0b", [response.movedTabs, response.label, windowsPart, groupPart, response.duplicatesClosed?globalThis.atelierI18n.t("ui_duplicate_videos_closed_878ef0", [response.duplicatesClosed]):'', response.warningCount?globalThis.atelierI18n.t("ui_see_the_task_list_for_details_d378c1"):""]));
  } catch (error) {
    setStatus(error?.message || globalThis.atelierI18n.t("ui_unknown_error_617580"), true);
  } finally {
    button.disabled = false;
  }
}

async function handleCloseGroup(groupKey, groupLabel, button) {
  button.disabled = true;
  setStatus(globalThis.atelierI18n.t("ui_closing_f6dabe", [groupLabel]));

  try {
    suppressInvalidationRefresh();
    const response = await sendMessage(
      MESSAGE_TYPES.CLOSE_GROUP_TABS,
      {
        groupBy: activeGroupBy,
        groupKey
      },
      globalThis.atelierI18n.t("ui_could_not_close_the_group_d3db6a")
    );
    setStatus(globalThis.atelierI18n.t("ui_tabs_from_closed_225d09", [response.closedTabs, response.label]));
    await refreshActiveGroups("", { keepStatus: false });
  } catch (error) {
    setStatus(error?.message || globalThis.atelierI18n.t("ui_unknown_error_617580"), true);
  } finally {
    button.disabled = false;
  }
}

UI.runButton.addEventListener("click", async () => {
  UI.runButton.disabled = true;
  setStatus(globalThis.atelierI18n.t("ui_exporting_1c4ed9"));

  try {
    let response = await sendMessage(
      MESSAGE_TYPES.EXPORT_WATCH_TABS,
      {},
      globalThis.atelierI18n.t("ui_export_failed_e6a141")
    );

    response = await sendMessage("download-export", { taskId: response.taskId });
    setStatus(globalThis.atelierI18n.t("ui_export_videos_84fc95", [response.count]));
    setDetails([
      globalThis.atelierI18n.t("ui_youtube_tabs_6baaf9", [response.matchedTabs]),
      globalThis.atelierI18n.t("ui_videos_ed7d0e", [response.count]),
      globalThis.atelierI18n.t("ui_file_a578ba", [response.filename])
    ]);
  } catch (error) {
    setStatus(error?.message || globalThis.atelierI18n.t("ui_unknown_error_617580"), true);
  } finally {
    UI.runButton.disabled = false;
  }
});

UI.refreshChannelsButton.addEventListener("click", async () => {
  try {
    await refreshActiveGroups(getModeCopy(activeGroupBy).loading, { keepStatus: false });
  } catch { /* Status already reports the error. */ }
});

UI.saveThresholdButton.addEventListener("click", async () => {
  await saveThreshold();
});

UI.thresholdInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  await saveThreshold();
});

for (const button of [UI.modeChannelButton, UI.modeTopicButton]) {
  button.addEventListener("click", async () => {
    const nextGroupBy = normalizeGroupBy(button.dataset.groupBy);
    if (nextGroupBy === activeGroupBy) {
      return;
    }

    // Finish an older request before changing modes so it cannot overwrite the selection.
    if (groupLoadPromise) {
      try { await groupLoadPromise; } catch { /* Allow retry in the selected mode. */ }
    }
    syncModeUi(nextGroupBy);
    UI.channelList.textContent = "";
    UI.channelEmpty.hidden = true;
    suppressInvalidationRefresh();
    try {
      await refreshActiveGroups(getModeCopy(nextGroupBy).loading, { keepStatus: false });
    } catch { /* Status already reports the error. */ }
  });
}

UI.channelList.addEventListener("click", async (event) => {
  const clickedNode = event.target;
  const clickedElement =
    clickedNode instanceof Element ? clickedNode : clickedNode?.parentElement || null;

  if (!clickedElement) {
    return;
  }

  const row = clickedElement.closest(".channel-item");
  if (!(row instanceof HTMLElement)) {
    return;
  }

  const groupKey = row.dataset.groupKey;
  const groupLabel = row.dataset.groupLabel;
  if (!groupKey || !groupLabel) {
    return;
  }

  const actionButton = clickedElement.closest("button[data-action]");
  if (!(actionButton instanceof HTMLButtonElement)) {
    return;
  }

  if (actionButton.dataset.action === "move") {
    await handleMoveGroup(groupKey, groupLabel, actionButton);
    return;
  }

  if (actionButton.dataset.action === "close") {
    await handleCloseGroup(groupKey, groupLabel, actionButton);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== MESSAGE_TYPES.GROUPS_INVALIDATED) {
    return;
  }

  scheduleInvalidatedRefresh();
});

window.addEventListener("unload", () => {
  clearPartialRefreshTimer();
  clearInvalidationRefreshTimer();
});

async function initializePopup() {
  try {
    await loadSettings();
  } catch {
    channelActionMinCount = DEFAULT_CHANNEL_ACTION_MIN_COUNT;
    syncModeUi(activeGroupBy);
  }

  try {
    await loadGroupActions({ showLoadingStatus: true });
  } catch {
    clearPartialRefreshTimer();
  }
}

const topicForm = document.getElementById("topicAliasForm");
const topicTarget = document.getElementById("topicTarget");
const topicVariants = document.getElementById("topicVariants");
const topicChoice = document.getElementById("topicChoice");
const topicAliasList = document.getElementById("topicAliasList");
const topicAliasStatus = document.getElementById("topicAliasStatus");
let aliasBusy = false;

function updateTopicChoices(labels) {
  const selected = topicChoice.value;
  const choices = [...new Set(labels)].sort((a, b) => a.localeCompare(b, "de"));
  const datalist = document.getElementById("topicChoices");
  topicChoice.replaceChildren();
  datalist.replaceChildren();
  for (const label of choices) {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    topicChoice.append(option);
    datalist.append(option.cloneNode(true));
  }
  if (choices.includes(selected)) topicChoice.value = selected;
  document.getElementById("addTopicChoice").disabled = aliasBusy || !choices.length;
}

function aliasStatus(text, error = false) {
  topicAliasStatus.textContent = text;
  topicAliasStatus.classList.toggle("error", error);
}

function renderAliases(rules) {
  topicAliasList.replaceChildren();
  for (const rule of rules) {
    const row = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `${rule.alias} → ${rule.target}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "row-button close-button";
    remove.textContent = globalThis.atelierI18n.t("ui_remove_382837");
    remove.dataset.alias = rule.alias;
    remove.disabled = aliasBusy;
    remove.setAttribute("aria-label", globalThis.atelierI18n.t("ui_remove_rule_for_5082f7", [rule.alias]));
    row.append(text, remove);
    topicAliasList.append(row);
  }
}

async function editAliases(type, payload) {
  if (aliasBusy) return;
  aliasBusy = true;
  for (const button of [...topicForm.querySelectorAll("button"), ...topicAliasList.querySelectorAll("button")]) button.disabled = true;
  aliasStatus(globalThis.atelierI18n.t("ui_saving_topic_rule_d37db9"));
  try {
    const result = await sendMessage(type, payload);
    renderAliases(result.rules);
    if (type === "save-topic-aliases") topicVariants.value = "";
    aliasStatus(type === "remove-topic-alias" ? globalThis.atelierI18n.t("ui_topic_rule_removed_5255f1") : globalThis.atelierI18n.t("ui_saved_the_rule_will_also_apply_to_future_titles_231095"));
    // Wait for the old snapshot before requesting the newly grouped records.
    if (groupLoadPromise) await groupLoadPromise.catch(() => {});
    await refreshActiveGroups(globalThis.atelierI18n.t("ui_refreshing_topics_96bd61"));
  } catch (error) { aliasStatus(error.message, true); }
  finally {
    aliasBusy = false;
    for (const button of [...topicForm.querySelectorAll("button"), ...topicAliasList.querySelectorAll("button")]) button.disabled = false;
    document.getElementById("addTopicChoice").disabled = !topicChoice.options.length;
  }
}

document.getElementById("addTopicChoice").addEventListener("click", () => {
  const value = topicChoice.value;
  const existing = topicVariants.value.split("\n").map(line => line.trim()).filter(Boolean);
  if (value && !existing.includes(value)) topicVariants.value = [...existing, value].join("\n");
});
topicForm.addEventListener("submit", event => {
  event.preventDefault();
  editAliases("save-topic-aliases", {
    target: topicTarget.value,
    aliases: topicVariants.value.split("\n").map(line => line.trim()).filter(Boolean)
  });
});
topicAliasList.addEventListener("click", event => {
  const button = event.target.closest("button[data-alias]");
  if (button) editAliases("remove-topic-alias", { alias: button.dataset.alias });
});
sendMessage("get-topic-aliases").then(result => renderAliases(result.rules), error => aliasStatus(error.message, true));
initializePopup();
