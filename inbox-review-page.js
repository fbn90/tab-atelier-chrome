import './i18n.js';
const button=document.getElementById('endProtection');
const status=document.getElementById('protectionStatus');
const t=globalThis.atelierI18n.t;
async function request(type){
  try{
    const response=await chrome.runtime.sendMessage({type});
    if(!response?.ok)throw Error(response?.error||t('reviewWindowChanged'));
    if(response.title)document.getElementById('groupTitle').textContent=response.title;
    status.textContent=t(!response.active?'reviewProtectionInactive':response.bypass?'reviewProtectionActive':'reviewProtectionPending');
    button.hidden=!(response.active&&response.bypass);
  }catch(error){status.textContent=error.message}
}
button.addEventListener('click',async()=>{
  button.disabled=true;
  await request('review-protection-stop');
  button.disabled=false;
});
request('review-protection-status');
