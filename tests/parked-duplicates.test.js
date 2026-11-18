import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateKey, duplicatePairs } from '../tab-rules.js';
import { navigationKey, tabParkerTarget, TAB_PARKER_STORE_ID, setApprovedParkerIds } from '../youtube-url.js';

// A keyless unpacked Parker participates only after the user paired it.
const PAIRED_PARKER_ID = 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
setApprovedParkerIds([PAIRED_PARKER_ID]);

const video = 'https://www.youtube.com/watch?v=x5IBwQhYUR0';
const parked = (target = video, title = 'Ein Titel', id = TAB_PARKER_STORE_ID) =>
  `chrome-extension://${id}/parked.html?title=${encodeURIComponent(title)}#${target}`;
const tab = (id, url, extra = {}) => ({ id, url, status: 'complete', discarded: false, pinned: false, incognito: false, ...extra });

test('store and paired unpacked parked pages resolve to the original URL without fetching it', () => {
  for (const id of [TAB_PARKER_STORE_ID, PAIRED_PARKER_ID]) {
    const target = `${video}&next=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2#chapter%23one`;
    assert.equal(tabParkerTarget(parked(target, 'Deutsch / English', id)), target);
  }
});

test('parked titles and video URL formats do not create a different duplicate identity', () => {
  const urls = [video, parked(video), parked('https://youtu.be/x5IBwQhYUR0?t=90&si=share', 'Anderer Titel'),
    parked('https://www.youtube.com/shorts/x5IBwQhYUR0?feature=share'),
    parked('https://www.youtube.com/live/x5IBwQhYUR0#t=12'),
    parked('https://www.youtube.com/embed/x5IBwQhYUR0?start=5'),
    parked('https://www.youtube.com/v/x5IBwQhYUR0')];
  assert.equal(new Set(urls.map(navigationKey)).size, 1);
  assert.equal(duplicatePairs(urls.map((url, index) => tab(index + 1, url)), {}).length, urls.length - 1);
});

test('playlist/language/query and non-time fragment context stays distinct', () => {
  for (const suffix of ['&list=playlist', '&hl=de', '&query=one', '#chapter']) {
    assert.notEqual(navigationKey(parked(video + suffix)), navigationKey(video));
    assert.equal(navigationKey(parked(video + suffix)), navigationKey(video + suffix));
  }
  const playlist = 'https://www.youtube.com/playlist?list=PLabc';
  assert.equal(navigationKey(parked(playlist)), navigationKey(playlist));
});

test('arbitrary browser and extension pages never become duplicate candidates', () => {
  const invalid = [
    parked('https://example.com/watch?v=x5IBwQhYUR0'),
    parked('https://youtube.com.evil.example/watch?v=x5IBwQhYUR0'),
    parked('https://user@www.youtube.com/watch?v=x5IBwQhYUR0'),
    parked('https://www.youtube.com:444/watch?v=x5IBwQhYUR0'),
    parked().replace('/parked.html', '/other.html'),
    parked().replace('?title=', '?redirect='),
    parked().replace('?title=', '?title=one&title='),
    parked().replace(TAB_PARKER_STORE_ID, 'invalid-extension-id'),
    parked().replace(TAB_PARKER_STORE_ID, 'abcdefghijklmnopabcdefghijklmnop'),
    parked().replace('chrome-extension:', 'file:'),
    `chrome-extension://${TAB_PARKER_STORE_ID}/popup.html`,
    `chrome-extension://${TAB_PARKER_STORE_ID}/parked.html#javascript:alert(1)`,
    'chrome://newtab/'
  ];
  for (const url of invalid) {
    assert.equal(tabParkerTarget(url), null, url);
    assert.equal(duplicateKey(tab(1, url)), null, url);
  }
});

test('recommendation and marketing tracking do not separate the same video', () => {
  const tracked = `${video}&pp=ygUMVGVzdCB2aWRlbw%3D%3D&ab_channel=Example&utm_source=share&utm_medium=social&utm_campaign=one`;
  assert.equal(navigationKey(tracked), navigationKey(video));
  assert.equal(navigationKey(parked(tracked)), navigationKey(video));
  assert.equal(duplicatePairs([tab(1, parked(video)), tab(2, tracked)], {}).length, 1);
  assert.notEqual(navigationKey(`${tracked}&hl=de&list=PLabc`), navigationKey(video));
});

test('loaded-state and privacy boundaries apply equally to parked pages', () => {
  const original = tab(1, parked());
  for (const extra of [{ pendingUrl: video }, { status: 'loading' }, { discarded: true }, { incognito: true }]) {
    assert.equal(duplicatePairs([original, tab(2, parked(), extra)], {}).length, 0);
  }
});

test('pinned and newest-tab keeper policy is preserved for loaded and parked copies', () => {
  const tabs = [tab(1, video, { pinned: true, active: true }), tab(2, parked()), tab(3, parked(video, 'Neu'))];
  const pairs = duplicatePairs(tabs, { 1: 1, 2: 2, 3: 3 });
  assert.deepEqual(pairs.map(pair => pair.keeper.id), [1, 1]);
  assert.deepEqual(pairs.map(pair => pair.loser.id), [3, 2]);
});
