import {meaningfulYouTubeTitle} from './youtube-url.js';

export function channelIdentity(raw) {
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.port||url.username||url.password||
      !['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname))return '';
    const path=decodeURIComponent(url.pathname).replace(/\/$/,'');
    return path.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]||
      path.match(/^\/(@[\p{L}\p{N}_.-]{1,100})$/u)?.[1].toLowerCase()||'';
  } catch {return ''}
}

export const hasCardDuration = title => /\s\d{1,4}\s(?:Minuten?|minutes?|Sekunden?|seconds?)\s*$/iu.test(title||'');

export function preferredVideoTitle(id, ...values) {
  const titles=values.map(title=>meaningfulYouTubeTitle(title,id)).filter(Boolean);
  return titles.find(title=>!hasCardDuration(title))||titles[0]||'';
}

export function channelIdentityKeys(records) {
  const handles=new Map(), conflicts=new Set();
  for(const {channelKey,channelHandle} of records){
    if(!channelKey?.startsWith('UC')||!channelHandle?.startsWith('@'))continue;
    if(handles.has(channelHandle)&&handles.get(channelHandle)!==channelKey)conflicts.add(channelHandle);
    else handles.set(channelHandle,channelKey);
  }
  const explicit=record=>{
    const handle=record.channelHandle||(record.channelKey?.startsWith('@')?record.channelKey:'');
    return record.channelKey?.startsWith('UC')?record.channelKey:
      (!conflicts.has(handle)&&handles.get(handle))||handle||'';
  };
  const names=new Map();
  const name=record=>String(record.channel||'').trim().normalize('NFKC').toLocaleLowerCase('de');
  for(const record of records){
    const key=explicit(record), label=name(record);
    if(!key||!label)continue;
    if(!names.has(label))names.set(label,key);
    else if(names.get(label)!==key)names.set(label,'');
  }
  return record=>explicit(record)||names.get(name(record))||'';
}
