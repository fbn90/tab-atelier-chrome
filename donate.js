import './i18n.js';
import {DONATIONS} from './donation-config.js';
export {BITCOIN_ADDRESS,BITCOIN_URI,MONERO_ADDRESS,MONERO_URI} from './donation-config.js';

export function installDonationPage(document,clipboard=globalThis.navigator?.clipboard) {
  const {t}=globalThis.atelierI18n;
  for(const donation of DONATIONS){
    const address=document.getElementById(donation.addressId);
    const copy=document.getElementById(donation.copyId);
    const wallet=document.getElementById(donation.walletId);
    const status=document.getElementById(donation.statusId);
    address.value=donation.address;
    wallet.href=donation.uri;
    wallet.hidden=false;
    copy.disabled=false;
    copy.addEventListener('click',async()=>{
      copy.disabled=true;
      status.textContent='';
      status.classList.remove('error');
      try {
        // Called directly from the click so Chrome can use the user's activation.
        await clipboard.writeText(donation.address);
        status.textContent=t(donation.copiedMessage);
      } catch {
        address.focus();
        address.select();
        status.textContent=t('donateCopyFallback');
        status.classList.add('error');
      } finally {copy.disabled=false}
    });
  }
}

if(typeof document!=='undefined')installDonationPage(document);
