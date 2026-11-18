import test from 'node:test';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url).href;
const yt = await import(root + 'youtube-url.js');
const {installParkerPairing} = await import(root + 'parker-pairing.js');
const {installParkerUpdate, UPDATE_JOURNAL} = await import(root + 'parker-update.js');

const SELF = 'pppppppppppppppppppppppppppppppp';
const LOCAL = 'dddddddddddddddddddddddddddddddd';   // path-derived Parker (or impostor)
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=20';
const answer = id => ({app: 'youtube-tab-parker', protocol: 1, id, version: '1.3.10'});
function event() { const l = []; return {addListener: f => l.push(f), fire: (...a) => l.map(f => f(...a))}; }
function mockApi({installed = [], tabs = [], local = {}} = {}) {
  const store = structuredClone(local), onChanged = event(), onMessage = event();
  const api = {
    runtime: {id: SELF, getURL: p => `chrome-extension://${SELF}/${p}`, onMessage,
      sendMessage: async id => { if (!api.installed.includes(id)) throw Error('Receiving end does not exist'); return answer(id); }},
    installed: [...installed], tabs: {query: async () => tabs.map(t => ({...t})), get: async id => {
      const t = tabs.find(x => x.id === id); if (!t) throw Error('No tab'); return {...t}; },
      update: async (id, {url}) => { const t = tabs.find(x => x.id === id); t.url = url; t.status = 'complete'; return {...t}; }},
    storage: {onChanged, local: {get: async key => key in store ? {[key]: structuredClone(store[key])} : {},
      set: async v => { const changes = {}; for (const [k, val] of Object.entries(v)) { changes[k] = {newValue: val}; store[k] = structuredClone(val); } onChanged.fire(changes, 'local'); }}},
    store
  };
  return api;
}
const page = api => ({id: SELF, url: api.runtime.getURL('inbox.html')});
const send = (api, message, sender = page(api)) => new Promise(resolve => {
  const handled = api.runtime.onMessage.fire(message, sender, resolve);
  if (!handled.some(Boolean)) resolve(undefined);
});

test('unpaired Parker that answers the probe is not trusted', async () => {
  const api = mockApi({installed: [LOCAL]});
  assert.equal(await yt.findTabParkerBase(api, []), null);
  assert.equal(yt.inboxParkedUrl(`chrome-extension://${LOCAL}/`, VIDEO, 'Title'), VIDEO);
  assert.equal(yt.canCloseYouTubeSource(`chrome-extension://${LOCAL}/parked.html#${VIDEO}`), false);
});

test('pairing flow: status lists candidate, confirm trusts it, remove revokes it', async () => {
  const api = mockApi({installed: [LOCAL], tabs: [{id: 1, url: `chrome-extension://${LOCAL}/popup.html`}]});
  installParkerPairing(api);
  let status = await send(api, {type: 'parker-pairing-status'});
  assert.deepEqual(status.candidates, [LOCAL]);
  assert.equal(status.pinned.some(p => p.active), false);
  status = await send(api, {type: 'parker-pairing-set', id: LOCAL, approved: true});
  assert.equal(status.ok, true);
  assert.deepEqual(api.store[yt.PARKER_APPROVALS_KEY], [LOCAL]);
  assert.deepEqual(status.approved, [{id: LOCAL, active: true}]);
  assert.deepEqual(status.candidates, []);
  assert.equal(await yt.findTabParkerBase(api, []), `chrome-extension://${LOCAL}/`);
  const url = yt.inboxParkedUrl(`chrome-extension://${LOCAL}/`, VIDEO, 'Title');
  assert.ok(url.startsWith(`chrome-extension://${LOCAL}/parked.html?title=Title#`));
  assert.equal(yt.canCloseYouTubeSource(`chrome-extension://${LOCAL}/parked.html#${VIDEO}`), true);
  status = await send(api, {type: 'parker-pairing-set', id: LOCAL, approved: false});
  assert.deepEqual(api.store[yt.PARKER_APPROVALS_KEY], []);
  assert.equal(await yt.findTabParkerBase(api, []), null);
  assert.equal(yt.inboxParkedUrl(`chrome-extension://${LOCAL}/`, VIDEO, 'Title'), VIDEO);
});

test('pairing rejects untrusted senders, silent installs and bad IDs', async () => {
  const api = mockApi({installed: []});
  installParkerPairing(api);
  const foreign = await send(api, {type: 'parker-pairing-set', id: LOCAL, approved: true}, {id: 'x'.repeat(32), url: 'https://evil.example/'});
  assert.equal(foreign.ok, false);
  const fromTab = await send(api, {type: 'parker-pairing-set', id: LOCAL, approved: true}, {id: SELF, url: `chrome-extension://${SELF}/update-hold.html`});
  assert.equal(fromTab.ok, false);
  assert.equal((await send(api, {type: 'parker-pairing-set', id: LOCAL, approved: true})).ok, false);
  assert.equal((await send(api, {type: 'parker-pairing-set', id: 'not-an-id', approved: true})).ok, false);
  assert.equal(api.store[yt.PARKER_APPROVALS_KEY], undefined);
  assert.equal(await send(api, {type: 'something-else'}), undefined);
});

test('stored approvals load lazily before the first Inbox open', async () => {
  // Fresh module instance: simulates a service worker wake-up.
  const fresh = await import(root + 'youtube-url.js?wake');
  const api = mockApi({installed: [LOCAL], local: {[fresh.PARKER_APPROVALS_KEY]: [LOCAL]}});
  assert.equal(await fresh.findTabParkerBase(api, []), `chrome-extension://${LOCAL}/`);
});

test('restore migrates held tabs to the trusted Parker when the old ID is gone', async () => {
  const OLD = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const original = `chrome-extension://${OLD}/parked.html?title=Saved%20title&channel=Chan#${VIDEO}`;
  const hold = `chrome-extension://${SELF}/update-hold.html#${encodeURIComponent(original)}`;
  const tabs = [{id: 7, url: hold, status: 'complete', incognito: false, windowId: 1}];
  // Store Parker (pinned ID) is now installed with a fixed key; the old path-ID install is gone.
  const api = mockApi({installed: [yt.TAB_PARKER_STORE_ID], tabs,
    local: {[UPDATE_JOURNAL]: [{tabId: 7, originalUrl: original, holdUrl: hold, windowId: 1, incognito: false, pinned: false}]}});
  installParkerUpdate(api);
  const result = await send(api, {type: 'parker-update-restore'});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.restored, 1);
  assert.equal(tabs[0].url, `chrome-extension://${yt.TAB_PARKER_STORE_ID}/parked.html?title=Saved%20title&channel=Chan#${VIDEO}`);
  assert.deepEqual(api.store[UPDATE_JOURNAL], []);
});

test('restore keeps the original owner when it still answers', async () => {
  const original = `chrome-extension://${yt.TAB_PARKER_STORE_ID}/parked.html?title=T#${VIDEO}`;
  const hold = `chrome-extension://${SELF}/update-hold.html#${encodeURIComponent(original)}`;
  const tabs = [{id: 8, url: hold, status: 'complete', incognito: false, windowId: 1}];
  const api = mockApi({installed: [yt.TAB_PARKER_STORE_ID], tabs,
    local: {[UPDATE_JOURNAL]: [{tabId: 8, originalUrl: original, holdUrl: hold, windowId: 1, incognito: false, pinned: false}]}});
  installParkerUpdate(api);
  const result = await send(api, {type: 'parker-update-restore'});
  assert.equal(result.restored, 1);
  assert.equal(tabs[0].url, original);
});

test('restore without any trusted Parker leaves tabs held', async () => {
  const OLD = 'ffffffffffffffffffffffffffffffff';
  const original = `chrome-extension://${OLD}/parked.html?title=T#${VIDEO}`;
  const hold = `chrome-extension://${SELF}/update-hold.html#${encodeURIComponent(original)}`;
  const tabs = [{id: 9, url: hold, status: 'complete', incognito: false, windowId: 1}];
  const api = mockApi({installed: [], tabs,
    local: {[UPDATE_JOURNAL]: [{tabId: 9, originalUrl: original, holdUrl: hold, windowId: 1, incognito: false, pinned: false}]}});
  installParkerUpdate(api);
  const result = await send(api, {type: 'parker-update-restore'});
  assert.equal(result.restored, 0);
  assert.equal(result.unavailable, 1);
  assert.equal(tabs[0].url, hold);
  assert.equal(api.store[UPDATE_JOURNAL].length, 1);
});
