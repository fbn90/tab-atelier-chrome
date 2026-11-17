import './i18n.js';
import {reviewProtection,reviewId} from './inbox-review-protection.js';
export const AUTOMATION_SETTINGS='tabAutomationSettingsV1';
export const defaults=Object.freeze({domainRouting:false,totalLimitEnabled:false,totalLimit:40,youtubeLimitEnabled:false,youtubeLimit:20,autoMetadata:false,youtubeGrouping:'channel'});
const youtubeGroupModes=['off','channel','topic'];
export async function readTabSettings(api){
  const saved=(await api.storage.local.get(AUTOMATION_SETTINGS))[AUTOMATION_SETTINGS]||{};
  return {
    youtubeGrouping:youtubeGroupModes.includes(saved.youtubeGrouping)?saved.youtubeGrouping:defaults.youtubeGrouping,
    youtubeLimitEnabled:saved.youtubeLimitEnabled===true,
    youtubeLimit:Number.isInteger(saved.youtubeLimit)&&saved.youtubeLimit>=1&&saved.youtubeLimit<=10000?saved.youtubeLimit:defaults.youtubeLimit,
    autoMetadata:saved.autoMetadata===true,
    domainRouting:saved.domainRouting===true,
    totalLimitEnabled:saved.totalLimitEnabled===true,
    totalLimit:Number.isInteger(saved.totalLimit)&&saved.totalLimit>=1&&saved.totalLimit<=10000?saved.totalLimit:defaults.totalLimit
  };
}
export function validateTabSettings(patch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error(globalThis.atelierI18n.t("ui_invalid_settings_436f7c"));
  for(const key of Object.keys(patch)){
    if(!Object.hasOwn(defaults,key))throw Error(globalThis.atelierI18n.t("ui_unknown_setting_4b469c"));
    if(key==='youtubeGrouping'){
      if(!youtubeGroupModes.includes(patch[key]))throw Error(globalThis.atelierI18n.t('ui_invalid_switch_value_b20ed9'));
    }else if(key==='totalLimit'||key==='youtubeLimit'){
      if(!Number.isInteger(patch[key])||patch[key]<1||patch[key]>10000)throw Error(globalThis.atelierI18n.t("ui_please_enter_a_whole_number_of_tabs_between_1_and_10_18b2ba"));
    }else if(typeof patch[key]!=='boolean')throw Error(globalThis.atelierI18n.t("ui_invalid_switch_value_b20ed9"));
  }
  return patch;
}
export const isLimitPage=(api,tab)=>{
  try{
    const url=new URL(tab?.pendingUrl||tab?.url);url.search='';url.hash='';
    return url.href===api.runtime.getURL('tab-limit.html');
  }catch{return false}
};
export async function assertTabCapacity(api){
  const settings=await readTabSettings(api);
  if(settings.totalLimitEnabled){
    const tabs=await api.tabs.query({});
    const {markerTabs}=await reviewProtection(api,tabs);
    if(tabs.filter(tab=>!markerTabs.has(tab.id)&&!isLimitPage(api,tab)).length<settings.totalLimit)return;
    throw Error(globalThis.atelierI18n.t("ui_maximum_tab_count_reached_close_tabs_first_or_turn_o_af0b88", [settings.totalLimit]));
  }
}

export async function videoCapacityWarning(api, inventory, occupied) {
  const settings = await readTabSettings(api);
  const {markerTabs,protectedTabs}=await reviewProtection(api,inventory);
  const count = inventory.filter(tab => !markerTabs.has(tab.id)&&!isLimitPage(api,tab)).length;
  if(protectedTabs.size)occupied=inventory.filter(tab=>!protectedTabs.has(tab.id)&&reviewId(tab)).length;
  if (settings.totalLimitEnabled && count >= settings.totalLimit) {
    return globalThis.atelierI18n.t('ui_maximum_tab_count_reached_close_tabs_first_or_turn_o_af0b88',[settings.totalLimit]);
  }
  if (settings.youtubeLimitEnabled && occupied >= settings.youtubeLimit) {
    return globalThis.atelierI18n.t('overflowVideoFull',[settings.youtubeLimit]);
  }
}

export async function assertVideoCapacity(api, inventory, occupied) {
  const warning=await videoCapacityWarning(api,inventory,occupied);
  if(warning)throw Error(warning);
}
