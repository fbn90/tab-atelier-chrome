import './i18n.js';
const count=document.getElementById('limitCount'),status=document.getElementById('limitStatus'),disable=document.getElementById('disableLimit');
async function refresh(){
  try{
    const result=await chrome.runtime.sendMessage({type:'tab-limit-status'});
    if(!result?.ok)throw Error(result?.error||globalThis.atelierI18n.t("ui_status_unavailable_2cee92"));
    const {totalLimit,totalLimitEnabled}=result.settings;
    count.textContent=totalLimitEnabled?globalThis.atelierI18n.t("ui_tabs_open_your_limit_6e26d6", [result.count, totalLimit]):globalThis.atelierI18n.t("ui_tabs_open_the_global_limit_is_off_910829", [result.count]);
    status.textContent=!totalLimitEnabled?globalThis.atelierI18n.t("ui_you_can_open_new_tabs_again_260733"):result.count<totalLimit?globalThis.atelierI18n.t("ui_there_is_room_again_open_your_desired_link_once_more_b34971"):'';
    disable.disabled=!totalLimitEnabled;
  }catch(error){status.textContent=error.message}
}
disable.addEventListener('click',async()=>{
  disable.disabled=true;
  try{const result=await chrome.runtime.sendMessage({type:'tab-limit-disable'});if(!result?.ok)throw Error(result?.error||globalThis.atelierI18n.t("ui_could_not_turn_off_the_limit_feebcf"));await refresh()}
  catch(error){status.textContent=error.message;disable.disabled=false}
});
chrome.tabs.onRemoved.addListener(refresh);chrome.tabs.onCreated.addListener(refresh);
chrome.storage.onChanged.addListener((_changes,area)=>{if(area==='local')refresh()});
refresh();
