import test from 'node:test';
import assert from 'node:assert/strict';
import {canCloseYouTubeSource,parseYouTubeTab,meaningfulYouTubeTitle,TAB_PARKER_STORE_ID,setApprovedParkerIds} from '../youtube-url.js';
// A keyless unpacked Parker participates only after the user paired it.
const PAIRED_PARKER_ID='kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
setApprovedParkerIds([PAIRED_PARKER_ID]);
const base=id=>`chrome-extension://${id}/parked.html`;

test('known parked video sources unwrap once and preserve original URL escapes and position',()=>{
  for(const id of [TAB_PARKER_STORE_ID,PAIRED_PARKER_ID])for(const target of [
    'https://www.youtube.com/watch?v=abc&t=90&x=a%26b%23c#t=120','https://youtu.be/abc?t=30',
    'https://www.youtube.com/shorts/abc','https://youtube.com/live/abc','https://youtube.com/embed/abc','https://youtube.com/v/abc'
  ]) {
    const video=parseYouTubeTab(`${base(id)}?title=${encodeURIComponent('  Ein\nTitel 🎬  ')}#${target}`);
    assert.equal(video.videoId,'abc');assert.equal(video.sourceUrl,target);assert.equal(video.parked,true);
    assert.equal(video.title,'Ein Titel 🎬');assert.equal(video.canonicalUrl,'https://www.youtube.com/watch?v=abc');
  }
});

test('tab parsing excludes forged parked pages and pure playlists without broadening persisted URL validation',()=>{
  for(const raw of [null,'bad',`${base('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')}#https://youtu.be/abc`,
    `${base(TAB_PARKER_STORE_ID)}#https://evil.example/watch?v=abc`,
    `${base(TAB_PARKER_STORE_ID)}#https://youtube.com@evil.example/watch?v=abc`,
    `${base(TAB_PARKER_STORE_ID)}?arbitrary=1#https://youtu.be/abc`,
    `${base(TAB_PARKER_STORE_ID)}#https://youtube.com/playlist?list=PLtest`,
    `${base(TAB_PARKER_STORE_ID)}#${base(TAB_PARKER_STORE_ID)}#https://youtu.be/abc`
  ])assert.equal(parseYouTubeTab(raw),null,raw);
  const ordinary=parseYouTubeTab('https://youtu.be/abc?t=90');
  assert.equal(ordinary.parked,false);assert.equal(ordinary.sourceUrl,'https://youtu.be/abc?t=90');
});

test('unpacked discovery requires the extension itself to confirm its identity',async()=>{
  const {discoverTabParkers}=await import('../youtube-url.js');
  const good='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',bad='cccccccccccccccccccccccccccccccc';
  const urls=[good,bad].map(id=>({url:`${base(id)}#https://youtu.be/abc?t=90`}));
  assert.equal(parseYouTubeTab(urls[0].url),null);
  const calls=[];
  await discoverTabParkers({runtime:{sendMessage:async(id,message)=>{
    calls.push({id,message});return {app:'youtube-tab-parker',protocol:1,id:id===good?id:good,version:'1.3.3'};
  }}},urls);
  assert.equal(parseYouTubeTab(urls[0].url).videoId,'abc');
  assert.equal(parseYouTubeTab(urls[1].url),null);
  assert.ok(calls.every(call=>JSON.stringify(call.message)==='{"type":"tab-parker-identify"}'));
});


test('legacy long parked titles are truncated without hiding a valid video',()=>{
  const title='Michael Every '+ '🎬'.repeat(220),target='https://youtu.be/longTitle?t=25';
  const video=parseYouTubeTab(`${base(TAB_PARKER_STORE_ID)}?title=${encodeURIComponent(title)}#${target}`);
  assert.equal(video.videoId,'longTitle');assert.equal(video.sourceUrl,target);
  assert.equal(Array.from(video.title).length,200);assert.ok(video.title.startsWith('Michael Every '));
  assert.equal(parseYouTubeTab(`${base(TAB_PARKER_STORE_ID)}?title=${'a'.repeat(20000)}#${target}`),null,'total URL remains bounded');
});

test('title quality excludes parked placeholders without rejecting meaningful YouTube titles',()=>{
  for(const title of ['YouTube','YouTube-Video geparkt','YouTube-Playlist geparkt','⏸ YouTube geparkt','YouTube · abc','YouTube Video parked'])
    assert.equal(meaningfulYouTubeTitle(title,'abc'),'');
  assert.equal(meaningfulYouTubeTitle(' Michael\nEvery on YouTube ','abc'),'Michael Every on YouTube');
});


test('Parker channel metadata is local, bounded and compatible with legacy title-only links',()=>{
 const target='https://music.youtube.com/watch?v=channelVideo&list=PLabc&t=15';
 const url=`${base(TAB_PARKER_STORE_ID)}?title=Michael+Every+on+trade&channel=Reinvent+Money#${target}`;
 const parsed=parseYouTubeTab(url);assert.equal(parsed.channel,'Reinvent Money');assert.equal(parsed.title,'Michael Every on trade');assert.equal(parsed.sourceUrl,target);
 assert.equal(parseYouTubeTab(`${base(TAB_PARKER_STORE_ID)}?channel=${'x'.repeat(201)}#${target}`),null);
 assert.equal(parseYouTubeTab(`${base(TAB_PARKER_STORE_ID)}?channel=a&channel=b#${target}`),null);
 assert.equal(parseYouTubeTab(`${base(TAB_PARKER_STORE_ID)}?title=Michael+Every#${target}`).channel,'');
 assert.equal(parseYouTubeTab(`${base(TAB_PARKER_STORE_ID)}?channel=Unbekannt#${target}`).channel,'');
});

test('closing requires a known Parker installation independently of display discovery',()=>{
  const target='https://www.youtube.com/watch?v=abc';
  assert.equal(canCloseYouTubeSource(target),true);
  assert.equal(canCloseYouTubeSource(`${base(TAB_PARKER_STORE_ID)}#${target}`),true);
  assert.equal(canCloseYouTubeSource(`${base('abcdefghijklmnopabcdefghijklmnop')}#${target}`),false);
});
