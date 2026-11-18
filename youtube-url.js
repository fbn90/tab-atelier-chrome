// Shared parsing for collection, metadata validation and duplicate detection.
export function parseYouTubeVideo(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    let videoId;
    if (host === 'youtu.be' || host === 'www.youtu.be') videoId = url.pathname.match(/^\/([^/]+)\/?$/)?.[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      if (url.pathname === '/watch') videoId = url.searchParams.get('v');
      else videoId = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/]+)\/?$/)?.[1];
    }
    if (!videoId || !/^[a-zA-Z0-9_-]{1,128}$/.test(videoId)) return null;
    return { videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
  } catch { return null; }
}

// Only known Tab Parker installs may participate. A similarly shaped page from
// another extension must never establish a reason to close a tab.
export const TAB_PARKER_STORE_ID = 'bhnabphdcdknjeebnmeikbdcncnfhdpf';
export const TAB_PARKER_UNPACKED_ID = 'pfijnbeaagokdgmnahpegnhgbneoodln';
// The unpacked ID is derived from this workspace's Parker extension folder.
// Add other explicitly trusted unpacked installation IDs here when needed.
const TRUSTED_PARKER_IDS = new Set([TAB_PARKER_STORE_ID, TAB_PARKER_UNPACKED_ID]);
const TAB_PARKER_IDS = new Set(TRUSTED_PARKER_IDS);
export function tabParkerTarget(raw, candidateOnly = false) {
  if (typeof raw !== 'string' || raw.length > 20000) return null;
  try {
    const page = new URL(raw);
    if (page.protocol !== 'chrome-extension:' || (!/^[a-p]{32}$/.test(page.hostname) || !candidateOnly && !TAB_PARKER_IDS.has(page.hostname)) ||
        page.pathname !== '/parked.html' || page.username || page.password || page.port) return null;
    const fields = [...page.searchParams.keys()];
    if (fields.some(key => !['title','channel'].includes(key)) || new Set(fields).size !== fields.length || Array.from(page.searchParams.get('channel')||'').length>200) return null;
    // The target fragment is already a full URL; decoding it would change %26,
    // %23 and nested parameters in an original link. Never follow it online.
    const target = page.hash.slice(1);
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const playlist = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname) &&
      url.pathname === '/playlist' && /^[a-zA-Z0-9_-]{1,128}$/.test(url.searchParams.get('list') || '');
    return parseYouTubeVideo(target) || playlist ? target : null;
  } catch { return null; }
}

// Discovery is useful for display, but cannot grant permission to close tabs.
export function canCloseYouTubeSource(raw) {
  if (!tabParkerTarget(raw, true)) return true;
  return TRUSTED_PARKER_IDS.has(new URL(raw).hostname);
}

// Keep persisted Inbox URLs independent of an extension installation. The
// local page URL is retained separately by the capture job for close checks.
export function parseYouTubeTab(raw) {
  const target = tabParkerTarget(raw);
  const video = parseYouTubeVideo(target || raw);
  if (!video) return null;
  const title = target ? new URL(raw).searchParams.get('title') || '' : '';
  return {...video, sourceUrl: target || raw, parked: Boolean(target),
    channel: target ? meaningfulChannel(new URL(raw).searchParams.get('channel')) : '',
    title: Array.from(title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200).join('')};
}

export function meaningfulChannel(value) {
  const text=typeof value==='string'?Array.from(value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,200).join(''):'';
  return /^(?:unbekannt|unknown|youtube)$/i.test(text)?'':text;
}

export function navigationKey(raw) {
  raw = tabParkerTarget(raw) || raw;
  const video = parseYouTubeVideo(raw);
  if (!video) return raw;
  const url = new URL(raw);
  // Ignore positions and share-link tracking, but preserve playlist/language/etc.
  for (const key of [...url.searchParams.keys()]) {
    if (['v', 't', 'start', 'end', 'time_continue', 'si', 'feature', 'pp', 'ab_channel'].includes(key) ||
        /^utm_/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  let hash=url.hash;
  if(/^#(?:t|start|time_continue)=/i.test(hash)) {
    const fields=new URLSearchParams(hash.slice(1));
    for(const key of ['t','start','time_continue'])fields.delete(key);
    hash=fields.toString()?`#${fields}`:'';
  }
  const rest = url.searchParams.toString();
  return `${video.canonicalUrl}${rest ? `&${rest}` : ''}${hash}`;
}

// Only public build identity is exchanged, never titles or video URLs.
// Coalesce in-flight probes only: each later open checks if Parker is enabled.
const identityChecks = new Map();
export function identifyTabParker(api,id) {
  if(identityChecks.has(id))return identityChecks.get(id);
  const check=(async()=>{
    let timer;
    try {
      const answer=await Promise.race([
        api.runtime.sendMessage(id,{type:'tab-parker-identify'}),
        new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000)})
      ]);
      if(answer?.app==='youtube-tab-parker'&&answer.protocol===1&&answer.id===id&&typeof answer.version==='string') {
        TAB_PARKER_IDS.add(id);return true;
      }
    }catch{/* Missing, disabled, older or unrelated extension. */}
    finally{clearTimeout(timer)}
    return false;
  })().finally(()=>identityChecks.delete(id));
  identityChecks.set(id,check);return check;
}
export async function discoverTabParkers(api,tabs) {
  const ids=new Set();
  for(const tab of tabs) {
    const raw=tab.pendingUrl||tab.url;
    if(tabParkerTarget(raw,true)) {
      const id=new URL(raw).hostname;
      if(!TAB_PARKER_IDS.has(id))ids.add(id);
    }
  }
  return (await Promise.all([...ids].map(id=>identifyTabParker(api,id)))).some(Boolean);
}

export async function findTabParkerBase(api,_tabs) {
  // Opening an Inbox video hands its title, channel and URL to the target page.
  // Any extension can answer the identity probe, so only pinned IDs qualify;
  // discovered installs stay readable but never receive new navigations.
  const ids=new Set(TRUSTED_PARKER_IDS);
  ids.delete(api.runtime.id);
  try {
    return await Promise.any([...ids].map(async id=>{
      if(await identifyTabParker(api,id))return `chrome-extension://${id}/`;
      throw Error('Parker unavailable');
    }));
  }catch{return null;}
}
export function meaningfulYouTubeTitle(value,videoId) {
  if(typeof value!=='string')return '';
  const title=Array.from(value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,200).join('');
  if(!title||title===`YouTube · ${videoId}`||/^(?:YouTube(?:[- ]Video|[- ]Playlist)?(?: geparkt| parked)?|(?:Video|Playlist) parked|⏸ YouTube geparkt)$/i.test(title))return '';
  return title;
}
export function parkedVideoTitle(parsed, tabTitle) {
  const stored = meaningfulYouTubeTitle(parsed.title, parsed.videoId);
  if (stored) return stored;
  const prefix = parsed.channel && `${parsed.channel} – `;
  const title = prefix && tabTitle?.startsWith(prefix) ? tabTitle.slice(prefix.length) : tabTitle;
  return meaningfulYouTubeTitle(title, parsed.videoId);
}

export function inboxParkedUrl(base,target,title,channel) {
  const video=parseYouTubeVideo(target),label=meaningfulYouTubeTitle(title,video?.videoId);
  if(!video||!label||!base)return target;
  try {
    const owner=new URL(base),source=new URL(target);
    if(owner.href!==`chrome-extension://${owner.hostname}/`||!TRUSTED_PARKER_IDS.has(owner.hostname)||
       source.username||source.password||source.port||!['youtube.com','www.youtube.com','m.youtube.com', 'music.youtube.com','youtu.be'].includes(source.hostname))return target;
    // Titles belong to the local placeholder, never to a YouTube request.
    return `${owner.href}parked.html?title=${encodeURIComponent(label)}${meaningfulChannel(channel)?'&channel='+encodeURIComponent(meaningfulChannel(channel)):''}#${target}`;
  }catch{return target;}
}
export function retitledInboxParkedUrl(tab,title) {
  if(!tab||tab.pendingUrl||tab.status==='loading')return null;
  const target=tabParkerTarget(tab.url);
  if(!target)return null;
  const page=new URL(tab.url),video=parseYouTubeVideo(target);
  if(meaningfulYouTubeTitle(page.searchParams.get('title'),video?.videoId))return null;
  const fixed=inboxParkedUrl(`${page.protocol}//${page.host}/`,target,title);
  return fixed!==target&&fixed!==tab.url?fixed:null;
}
export async function verifiedInboxParkedRepair(api,tab,title) {
  const proposal=retitledInboxParkedUrl(tab,title);
  if(!proposal)return null;
  // Another enabled Parker install does not make this tab's owner available.
  // Callers must revalidate the live tab after this asynchronous identity check.
  const owner=new URL(tab.url).hostname;
  return await identifyTabParker(api,owner)?proposal:null;
}
