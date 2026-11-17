import './i18n.js';
const youtubeGrouping=document.getElementById('youtubeGrouping');
const domainSwitch=document.getElementById('automaticDomainRouting');
const totalSwitch=document.getElementById('totalTabLimitEnabled');
const totalInput=document.getElementById('totalTabLimit');
const save=document.getElementById('saveTotalTabLimit'),sort=document.getElementById('sortDomainsNow');
const status=document.getElementById('tabAutomationStatus'),retry=document.getElementById('retryTabSettings');
const archiveSwitch=document.getElementById('youtubeLimitEnabled'), archiveInput=document.getElementById('youtubeLimit');
const protection=document.getElementById('enableTabProtection'), saveArchive=document.getElementById('saveYoutubeLimit');
let confirmed=null,busy=false;
function restore(){
  if(!confirmed)return;
  if(youtubeGrouping)youtubeGrouping.value=confirmed.youtubeGrouping ?? 'channel';
  archiveSwitch.checked=confirmed.youtubeLimitEnabled;archiveInput.value=confirmed.youtubeLimit;
  protection.hidden=confirmed.youtubeLimitEnabled&&confirmed.totalLimitEnabled;
  domainSwitch.checked=confirmed.domainRouting;totalSwitch.checked=confirmed.totalLimitEnabled;totalInput.value=confirmed.totalLimit;
}
function lock(value){
  for(const control of [domainSwitch,totalSwitch,totalInput,save,archiveSwitch,archiveInput,protection,saveArchive])control.disabled=value||!confirmed;
  if(youtubeGrouping)youtubeGrouping.disabled=value||!confirmed;
  sort.disabled=value||!confirmed?.domainRouting;
}
async function settings(patch){
  if(busy)return;busy=true;lock(true);status.classList.remove('error');
  try{
    const result=await chrome.runtime.sendMessage({type:'tab-automation-settings',...(patch?{patch}:{})});
    if(!result?.ok)throw Error(result?.error||globalThis.atelierI18n.t("ui_could_not_load_settings_456203"));
    confirmed=result.settings;restore();retry.hidden=true;
    status.textContent=globalThis.atelierI18n.t("ui_tabs_open_domain_sorting_global_limit_36f3ff", [result.count, confirmed.domainRouting?globalThis.atelierI18n.t("ui_on_ea325d"):globalThis.atelierI18n.t("ui_off_2337c3"), confirmed.totalLimitEnabled?confirmed.totalLimit:globalThis.atelierI18n.t("ui_off_2337c3"), result.warning?globalThis.atelierI18n.t("ui_retry_pending_05e90e", [result.warning]):'']);
    status.classList.toggle('error',!!result.warning);
  }catch(error){restore();status.textContent=error.message;status.classList.add('error');retry.hidden=false}
  finally{busy=false;lock(false)}
}
youtubeGrouping?.addEventListener('change',()=>settings({youtubeGrouping:youtubeGrouping.value}));
domainSwitch.addEventListener('change',()=>settings({domainRouting:domainSwitch.checked}));
totalSwitch.addEventListener('change',()=>{
  if(!totalSwitch.checked){settings({totalLimitEnabled:false});return}
  if(!totalInput.reportValidity()){restore();return}
  settings({totalLimitEnabled:true,totalLimit:Number(totalInput.value)});
});
save.addEventListener('click',()=>{if(totalInput.reportValidity())settings({totalLimit:Number(totalInput.value)})});
protection.addEventListener('click',()=>settings({totalLimitEnabled:true,totalLimit:60,youtubeLimitEnabled:true,youtubeLimit:20}));
archiveSwitch.addEventListener('change',()=>{
  if(!archiveInput.reportValidity()){restore();return}
  settings({youtubeLimitEnabled:archiveSwitch.checked,youtubeLimit:Number(archiveInput.value)});
});
saveArchive.addEventListener('click',()=>{if(archiveInput.reportValidity())settings({youtubeLimit:Number(archiveInput.value)})});
chrome.runtime.onMessage.addListener(message=>{if(message?.type==='tab-protection-changed')settings()});
retry.addEventListener('click',()=>settings());
sort.addEventListener('click',async()=>{
  if(busy)return;busy=true;lock(true);
  try{const result=await chrome.runtime.sendMessage({type:'tab-automation-sort'});if(!result?.ok)throw Error(result?.error||globalThis.atelierI18n.t("ui_sorting_failed_2dcc1d"));status.textContent=globalThis.atelierI18n.t("ui_collecting_existing_ungrouped_tabs_by_domain_see_tas_6f97b6");status.classList.remove('error')}
  catch(error){status.textContent=error.message;status.classList.add('error')}
  finally{busy=false;lock(false)}
});
settings();
