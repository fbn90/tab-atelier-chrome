import './i18n.js';
import {preferredVideoTitle} from './youtube-metadata.js';
import {meaningfulYouTubeTitle,parkedVideoTitle} from './youtube-url.js';

const searchText=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'')
  .toLocaleLowerCase('de').replace(/\s+/g,' ').trim();

export function captureFilters(payload={}) {
  if(payload.titleSearch!==undefined&&(typeof payload.titleSearch!=='string'||Array.from(payload.titleSearch).length>200)||
      payload.parkedOnly!==undefined&&typeof payload.parkedOnly!=='boolean') {
    throw Error(globalThis.atelierI18n.t('ui_capture_invalid_filter'));
  }
  return {titleSearch:payload.titleSearch||'',parkedOnly:payload.parkedOnly===true};
}

export function captureTabTitle(tab,parsed,local={}) {
  if (parsed.parked) {
    return preferredVideoTitle(parsed.videoId, parsed.title, local.title || local.tabTitle, parkedVideoTitle(parsed, tab.title));
  }
  return meaningfulYouTubeTitle(tab.title, parsed.videoId) || tab.title || '';
}

export function matchesCaptureFilters(title,parked,filters) {
  return (!filters.parkedOnly||parked)&&searchText(title).includes(searchText(filters.titleSearch));
}
