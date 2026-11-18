import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_PARKER_STORE_ID, findTabParkerBase, inboxParkedUrl,
  retitledInboxParkedUrl, verifiedInboxParkedRepair, parseYouTubeTab
} from '../youtube-url.js';

const base = `chrome-extension://${TAB_PARKER_STORE_ID}/`;
const target = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=20';
const answer = id => ({ app: 'youtube-tab-parker', protocol: 1, id, version: '1.3.4' });
const api = sendMessage => ({ runtime: { id: 'cccccccccccccccccccccccccccccccc', sendMessage } });

test('Inbox discovery exchanges public build identity without saved titles or video URLs', async () => {
  const calls = [];
  const result = await findTabParkerBase(api(async (id, message) => {
    calls.push({ id, message });
    return id === TAB_PARKER_STORE_ID ? answer(id) : undefined;
  }), []);
  assert.equal(result, base);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => JSON.stringify(call.message) === '{"type":"tab-parker-identify"}'));
});

test('missing and disabled Parker leave the original YouTube address unchanged', async () => {
  for (const send of [async () => undefined, async () => { throw new Error('Receiving end does not exist'); }]) {
    const found = await findTabParkerBase(api(send), []);
    assert.equal(found, null);
    assert.equal(inboxParkedUrl(found, target, 'Saved Inbox title'), target);
  }
});

test('an earlier positive identity check does not survive disabling Parker', async () => {
  let enabled = true;
  const browser = api(async id => enabled && id === TAB_PARKER_STORE_ID ? answer(id) : undefined);
  assert.equal(await findTabParkerBase(browser, []), base);
  enabled = false;
  assert.equal(await findTabParkerBase(browser, []), null);
});

test('wrong application, protocol or sender identity cannot select a Parker destination', async () => {
  for (const change of [{ app: 'other-extension' }, { protocol: 2 }, { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { version: null }]) {
    const found = await findTabParkerBase(api(async id => ({ ...answer(id), ...change })), []);
    assert.equal(found, null);
  }
});

test('an extension answering the identity probe never becomes an Inbox destination unless pinned or paired', async () => {
  // Any installed extension can answer the probe; only pinned or user-paired IDs may receive titles, channels and URLs.
  const id = 'dddddddddddddddddddddddddddddddd';
  const customBase = `chrome-extension://${id}/`;
  const probed = [];
  const found = await findTabParkerBase(api(async candidate => { probed.push(candidate); return candidate === id ? answer(id) : undefined; }), [
    { url: `${customBase}popup.html` }, { url: `${customBase}parked.html#${target}` }
  ]);
  assert.equal(found, null);
  assert.ok(!probed.includes(id));
  assert.equal(inboxParkedUrl(customBase, target, 'Saved title'), target);
});

test('Unicode and reserved title characters stay local while the original fragment round-trips exactly', () => {
  const source = `${target}&next=https%3A%2F%2Fexample.org%2F%3Fa%3D1%26b%3D2%23part#t=90&chapter=one%23two`;
  const title = '  Deutsch 🎬\nEnglish & title? # <script>"quoted"</script>\u0000  ';
  const result = inboxParkedUrl(base, source, title);
  const page = new URL(result);
  assert.equal(page.protocol, 'chrome-extension:');
  assert.equal(page.hostname, TAB_PARKER_STORE_ID);
  assert.equal(page.pathname, '/parked.html');
  assert.equal(page.searchParams.get('title'), 'Deutsch 🎬 English & title? # <script>"quoted"</script>');
  assert.equal(page.hash.slice(1), source);
  assert.equal(parseYouTubeTab(result).sourceUrl, source);
  assert.equal(new URL(source).searchParams.has('title'), false);
});

test('long titles are limited by Unicode code point without splitting emoji', () => {
  const title = '🎬'.repeat(250);
  const result = inboxParkedUrl(base, target, title);
  const saved = new URL(result).searchParams.get('title');
  assert.equal(Array.from(saved).length, 200);
  assert.equal(saved, '🎬'.repeat(200));
});

test('untrusted destinations and malformed extension bases fall back to the exact original URL', () => {
  for (const owner of [null, '', 'https://example.com/', 'file:///tmp/',
    'chrome-extension://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/',
    `${base}other-page.html`, `${base}?override=1`, `${base}#fragment`,
    `chrome-extension://user@${TAB_PARKER_STORE_ID}/`]) {
    assert.equal(inboxParkedUrl(owner, target, 'Saved title'), target);
  }
});

test('unsupported Parker targets are never converted into an unusable local placeholder', () => {
  for (const source of ['https://example.org/watch?v=aqz-KE-bpKQ',
    'https://youtube.com.evil.example/watch?v=aqz-KE-bpKQ',
    'https://user:password@www.youtube.com/watch?v=aqz-KE-bpKQ',
    'https://www.youtube.com:444/watch?v=aqz-KE-bpKQ',
    'https://www.youtu.be/aqz-KE-bpKQ',
    'https://www.youtube.com./watch?v=aqz-KE-bpKQ',
    'javascript:alert(1)']) {
    assert.equal(inboxParkedUrl(base, source, 'Saved title'), source, source);
  }
});

test('empty and generic Inbox fallback labels do not replace a real video title', () => {
  for (const title of ['', '  ', 'YouTube', 'YouTube-Video geparkt', '⏸ YouTube geparkt', 'YouTube · aqz-KE-bpKQ']) {
    assert.equal(inboxParkedUrl(base, target, title), target);
  }
});

test('reused generic parked tabs can recover the saved title without changing their video URL', () => {
  for (const title of ['', 'YouTube-Video geparkt', '⏸ YouTube geparkt']) {
    const url = `${base}parked.html${title ? `?title=${encodeURIComponent(title)}` : ''}#${target}#t=90`;
    const repaired = retitledInboxParkedUrl({ url, status: 'complete', windowId: 7 }, 'Recovered title 🎬');
    assert.equal(new URL(repaired).searchParams.get('title'), 'Recovered title 🎬');
    assert.equal(new URL(repaired).hash, new URL(url).hash);
  }
});

test('repair preserves good parked titles and skips loaded, pending, loading or unrelated pages', () => {
  const generic = `${base}parked.html#${target}`;
  const good = inboxParkedUrl(base, target, 'Existing useful title');
  for (const tab of [{ url: good, status: 'complete' }, { url: target, status: 'complete' },
    { url: generic, pendingUrl: target, status: 'complete' }, { url: generic, status: 'loading' },
    { url: generic.replace(TAB_PARKER_STORE_ID, 'ffffffffffffffffffffffffffffffff'), status: 'complete' }]) {
    assert.equal(retitledInboxParkedUrl(tab, 'Saved title'), null);
  }
});

test('repair verifies the parked tab owner and returns only its local title proposal', async () => {
  const tab={id:17,url:`${base}parked.html#${target}`,status:'complete',windowId:7};
  const calls=[];
  const repaired=await verifiedInboxParkedRepair(api(async(id,message)=>{
    calls.push({id,message});return answer(id);
  }),tab,'Recovered title');
  assert.equal(repaired,retitledInboxParkedUrl(tab,'Recovered title'));
  assert.deepEqual(calls,[{id:TAB_PARKER_STORE_ID,message:{type:'tab-parker-identify'}}]);
  assert.equal(tab.url,`${base}parked.html#${target}`,'verification does not mutate or navigate the tab');
});

test('missing or disabled parked owner prevents repair even after a previous successful check', async () => {
  const tab={url:`${base}parked.html#${target}`,status:'complete'};
  let enabled=true;
  const browser=api(async id=>{
    if(!enabled)throw new Error('Receiving end does not exist');
    return answer(id);
  });
  assert.ok(await verifiedInboxParkedRepair(browser,tab,'Recovered title'));
  enabled=false;
  assert.equal(await verifiedInboxParkedRepair(browser,tab,'Recovered title'),null);
  assert.equal(await verifiedInboxParkedRepair(api(async()=>undefined),tab,'Recovered title'),null);
});

test('another active Parker owner cannot authorize repairing a disabled owner tab', async () => {
  const other='gggggggggggggggggggggggggggggggg';
  const otherBase=`chrome-extension://${other}/`;
  const calls=[];
  const browser=api(async(id,message)=>{
    calls.push({id,message});
    return id===other?answer(other):undefined;
  });
  assert.equal(await findTabParkerBase(browser,[{url:`${otherBase}popup.html`}]),null);
  calls.length=0;
  const tab={url:`${base}parked.html#${target}`,status:'complete'};
  assert.equal(await verifiedInboxParkedRepair(browser,tab,'Recovered title'),null);
  assert.deepEqual(calls,[{id:TAB_PARKER_STORE_ID,message:{type:'tab-parker-identify'}}]);
});

test('title repair does not probe owners when there is no safe repair proposal', async () => {
  let probes=0;
  const browser=api(async()=>{probes++;return undefined;});
  for(const tab of [{url:target,status:'complete'},
    {url:inboxParkedUrl(base,target,'Good existing title'),status:'complete'},
    {url:`${base}parked.html#${target}`,pendingUrl:target,status:'complete'}]) {
    assert.equal(await verifiedInboxParkedRepair(browser,tab,'Recovered title'),null);
  }
  assert.equal(probes,0);
});
