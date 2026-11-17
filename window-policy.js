import {domainOf} from './tab-rules.js';
export const isGrouped=tab=>Number.isInteger(tab?.groupId)&&tab.groupId>=0&&!tab.pinned;
export const DOMAIN_TARGETS='domainWindowTargetsV1';
export const domainContext=tab=>`${!!tab.incognito}|${domainOf(tab)}`;
export async function domainWindowTargets(api){return (await api.storage.session.get(DOMAIN_TARGETS))[DOMAIN_TARGETS]||{}}
export async function rememberDomainWindow(api,windowId,tab){
  const current=await domainWindowTargets(api),key=domainContext(tab);
  if(current[key]===windowId)return;
  current[key]=windowId;await api.storage.session.set({[DOMAIN_TARGETS]:current});
}
