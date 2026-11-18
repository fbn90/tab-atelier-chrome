import './i18n.js';
import {isTrustedPage} from './extension-pages.js';
import {PARKER_APPROVALS_KEY,approvedParkerIds,identifyTabParker,isPinnedParkerId,isTrustedParkerId,
  loadApprovedParkerIds,setApprovedParkerIds,TAB_PARKER_STORE_ID,unpairedParkerIds} from './youtube-url.js';

// Pairing: an unpacked Tab Parker without a manifest key has a path-derived ID.
// Answering the identity probe proves nothing (any extension can), so such an
// install only receives Inbox navigations after the user confirmed its ID here.
export function installParkerPairing(api){
  const isId=id=>typeof id==='string'&&/^[a-p]{32}$/.test(id);
  let writes=Promise.resolve();
  loadApprovedParkerIds(api);
  api.storage.onChanged?.addListener((changes,area)=>{
    if(area==='local'&&changes[PARKER_APPROVALS_KEY])setApprovedParkerIds(changes[PARKER_APPROVALS_KEY].newValue);
  });
  async function status(){
    await loadApprovedParkerIds(api);
    const candidates=new Set(unpairedParkerIds());
    for(const tab of await api.tabs.query({}))try{
      const url=new URL(tab.pendingUrl||tab.url);
      if(url.protocol==='chrome-extension:'&&isId(url.hostname)&&url.hostname!==api.runtime.id&&!isTrustedParkerId(url.hostname))candidates.add(url.hostname);
    }catch{}
    const probe=async id=>({id,active:await identifyTabParker(api,id)});
    const [pinned,approved,found]=await Promise.all([
      Promise.all([TAB_PARKER_STORE_ID].map(probe)),
      Promise.all(approvedParkerIds().map(probe)),
      Promise.all([...candidates].map(probe))
    ]);
    return {ok:true,pinned,approved,candidates:found.filter(entry=>entry.active).map(entry=>entry.id)};
  }
  function setApproval(id,approved){
    const operation=writes.then(async()=>{
      if(!isId(id)||id===api.runtime.id)throw Error(globalThis.atelierI18n.t('ui_parker_pairing_invalid'));
      if(isPinnedParkerId(id))return status();
      // Only an install that currently identifies as Tab Parker can be paired.
      if(approved&&!await identifyTabParker(api,id))throw Error(globalThis.atelierI18n.t('ui_parker_pairing_unavailable'));
      const stored=(await api.storage.local.get(PARKER_APPROVALS_KEY))[PARKER_APPROVALS_KEY];
      const list=new Set(Array.isArray(stored)?stored.filter(isId):[]);
      if(approved)list.add(id);else list.delete(id);
      await api.storage.local.set({[PARKER_APPROVALS_KEY]:[...list]});
      setApprovedParkerIds([...list]);
      return status();
    });
    writes=operation.catch(()=>{});
    return operation;
  }
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!['parker-pairing-status','parker-pairing-set'].includes(message?.type))return false;
    if(!isTrustedPage(sender,api)){reply({ok:false,error:globalThis.atelierI18n.t('ui_unauthorized_message_source_674efb')});return false}
    const operation=message.type==='parker-pairing-status'?status():setApproval(message.id,message.approved===true);
    operation.then(reply,error=>reply({ok:false,error:error.message}));
    return true;
  });
}
