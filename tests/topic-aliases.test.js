import {channelIdentity,channelIdentityKeys,hasCardDuration,preferredVideoTitle} from '../youtube-metadata.js';
import { installYouTubeAutoGroups } from '../youtube-auto-groups.js';
import { parkedVideoTitle, canCloseYouTubeSource } from '../youtube-url.js';
import './i18n-helper.js';
import {installParkerUpdate} from "../parker-update.js";
import { installInbox } from "../inbox-service.js";
import { isTrustedPage, validateWindowId } from "../extension-pages.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseYouTubeVideo as parseWatchVideo,parseYouTubeTab,discoverTabParkers,meaningfulYouTubeTitle,meaningfulChannel } from '../youtube-url.js';
import { createMetadataCache } from '../metadata-cache.js';
import { aliasKey, recognizeTopic, resolveTopicOverride, saveAliasRules } from '../topic-aliases.js';
import { createAliasStore, ALIAS_STORAGE_KEY } from '../topic-alias-store.js';

const karpTitles = ['Palantir CEO: The future', 'Alex Karp interview', 'ALEXANDER C. KARP speaks', 'Alexander Karp', 'CEO von Palantir', 'Alex C Karp on technology'];
const steinhoefelTitles = ['AFTER DARK mit JOACHIM STEINHÖFEL', '"Facebook ist das dümmste Unternehmen" | Rechtsanwalt Joachim Steinhöfel', 'Steinhöfel: Und POLITIKER wollen Fake News bekämpfen? | Interview 141'];

test('all supplied name and role variants resolve to one person', () => {
  for (const title of karpTitles) assert.equal(recognizeTopic(title), 'Alex Karp', title);
  for (const title of steinhoefelTitles) assert.equal(recognizeTopic(title), 'Joachim Steinhöfel', title);
});

test('Unicode, capitalization, punctuation, initials and umlaut spellings', () => {
  assert.equal(recognizeTopic('Joachim Steinhoefel spricht'), 'Joachim Steinhöfel');
  assert.equal(recognizeTopic('JOACHIM STEINHO\u0308FEL'), 'Joachim Steinhöfel');
  assert.equal(recognizeTopic('Alexander C.Karp: Interview'), 'Alex Karp');
  assert.equal(recognizeTopic('Palantir-CEO'), 'Alex Karp');
  assert.equal(recognizeTopic('Douglas Murray'), 'Douglas Murray');
});

test('no partial-word or ambiguous surname/company matches', () => {
  for (const title of ['Andreas Steinhöfel', 'Joachim Steinhöfeler', 'Alex Karper', 'Palantir shares rise', 'Former Palantir CEO', 'Neuer Palantir-CEO', 'Karp in the news']) {
    assert.equal(recognizeTopic(title), null, title);
  }
});

test('explicit people outrank roles; two people keep a deterministic first named subject', () => {
  assert.equal(recognizeTopic('Palantir CEO reacts to Joachim Steinhöfel'), 'Joachim Steinhöfel');
  assert.equal(recognizeTopic('Alex Karp meets Joachim Steinhöfel'), 'Alex Karp');
  assert.equal(recognizeTopic('Joachim Steinhöfel meets Alex Karp'), 'Joachim Steinhöfel');
});

test('custom corrections merge titles, existing labels and chains; cycles rejected', () => {
  let rules = saveAliasRules([], 'Alex Karp', ['Alexander C. Karp','Palantir boss']);
  assert.equal(recognizeTopic('Palantir boss speaking', rules), 'Alex Karp');
  rules = saveAliasRules(rules, 'Palantir leadership', ['Alex Karp']);
  assert.equal(recognizeTopic('Alexander Karp interview', rules), 'Palantir leadership');
  assert.equal(resolveTopicOverride('Alexander C. Karp', rules), 'Palantir leadership');
  assert.throws(() => saveAliasRules(rules, 'Alexander C. Karp', ['Palantir leadership']), /Kreis/);
  assert.equal(rules.length,3);
});

test('a longer user alias wins; explicit corrections can be changed', () => {
  let rules=saveAliasRules([], 'Technology', ['Palantir']);
  rules=saveAliasRules(rules, 'Alex Karp', ['Palantir CEO']);
  assert.equal(recognizeTopic('Palantir CEO interview',rules),'Alex Karp');
  rules=saveAliasRules(rules, 'Leadership', ['PALANTIR-CEO']);
  assert.equal(rules.length,2);
  assert.equal(recognizeTopic('Palantir CEO interview',rules),'Leadership');
  assert.throws(()=>saveAliasRules([], 'Valid', [' '.repeat(4)]));
  assert.throws(()=>saveAliasRules([], 'x'.repeat(73), ['Valid']));
});

function memoryStorage() {
  const data={};
  return {data,async get(key){return {[key]:structuredClone(data[key])}},async set(value){Object.assign(data,structuredClone(value))}};
}

test('saved rules survive worker restart, concurrent saves and removal',async()=>{
  const storage=memoryStorage();let changes=0;
  const store=createAliasStore(storage,()=>changes++);
  await Promise.all([store.save('Person A',['A variant']),store.save('Person B',['B variant'])]);
  assert.equal(store.rules.length,2);
  const restarted=createAliasStore(storage,()=>{});
  await restarted.load();
  assert.equal(recognizeTopic('B variant interview',restarted.rules),'Person B');
  await restarted.remove('B variant');
  assert.equal(recognizeTopic('B variant interview',restarted.rules),null);
  assert.equal(storage.data[ALIAS_STORAGE_KEY].length,1);
  assert.ok(changes>=3);
});

function backgroundFixture(liveTabs = new Map(), removed = []) {
  const storage=memoryStorage();
  const events=()=>({addListener(){}});
  const chrome={
    runtime:{id:'test',onMessage:events(),getURL:p=>`chrome-extension://test/${p}`},
    tabs:{onCreated:events(),onRemoved:events(),onReplaced:events(),onUpdated:events(),
      async get(id){if(!liveTabs.has(id)) throw Error('No tab');return {...liveTabs.get(id)}},
      async remove(id){removed.push(id);liveTabs.delete(id)}},
    storage:{local:storage,onChanged:events()}
  };
  const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8').replace(/^(?:import|export) .*;\n/gm,'');
  return vm.runInNewContext(source+`\n({
    buildGroupsFromRecords, getMatchingGroupRecords, getCachedStateGroups, topicAliases,
    async handleCloseGroupTabs(groupBy,groupKey) {
      let data;
      const job={type:'close-group-tabs',payload:{groupBy,groupKey},cursor:0};
      const ctx={cancelled:()=>false,write:async value=>{data=value},read:async()=>data,effect:async fn=>{await fn();return true}};
      while(!await groupStep(job,ctx)){}
      return job.result;
    },
    seed(records) { channelScanState = {generation:scanGeneration,records, pendingEntries:[], nextIndex:0, groupsCache:new Map()}; return channelScanState; }
  })`,{atelierI18n:globalThis.atelierI18n,chrome,installYouTubeAutoGroups,parkedVideoTitle,canCloseYouTubeSource,channelIdentity,channelIdentityKeys,hasCardDuration,preferredVideoTitle,installAutomaticMetadata:()=>({}),installParkerUpdate,installParkerPairing:()=>{},installInbox,isTrustedPage,validateWindowId,recognizeTopic,resolveTopicOverride,createAliasStore,ALIAS_STORAGE_KEY,parseWatchVideo,parseYouTubeTab,discoverTabParkers,meaningfulYouTubeTitle,meaningfulChannel,createMetadataCache,runExclusive:fn=>fn(),taskService:()=>({register(){},async resume(){}}),URL,AbortSignal,setTimeout:()=>0,clearTimeout(){}});
}

test('real grouping pipeline gives people priority over repeated title fragments',async()=>{
  const app=backgroundFixture();await app.topicAliases.load();
  const records=[...karpTitles,...steinhoefelTitles].map((title,i)=>({title,channel:'Interview Channel',tabId:i+1}));
  for(let i=0;i<12;i++) records.push({title:'Facebook ist das dümmste Unternehmen | random',channel:'Other',tabId:100+i});
  const groups=app.buildGroupsFromRecords(records,'topic',{includeRecords:true});
  assert.equal(groups.find(g=>g.label==='Alex Karp').count,karpTitles.length);
  assert.equal(groups.find(g=>g.label==='Joachim Steinhöfel').count,3);
  assert.equal(app.buildGroupsFromRecords(records,'channel').find(g=>g.label==='Interview Channel').count,9);
});

test('cached list and action selection immediately follow saved corrections and undo',async()=>{
  const app=backgroundFixture();await app.topicAliases.load();
  const records=[{title:'Palantir CEO',channel:'A',tabId:1},{title:'New interview with Alexander Karp',channel:'B',tabId:2}];
  const state=app.seed(records);
  assert.equal(app.getCachedStateGroups(state,'topic')[0].label,'Alex Karp');
  await app.topicAliases.save('Technology leaders',['Alex Karp']);
  assert.equal(app.getCachedStateGroups(state,'topic')[0].label,'Technology leaders');
  const selected=await app.getMatchingGroupRecords('topic','technology leaders');
  assert.deepEqual(Array.from(selected.records,r=>r.tabId),[1,2]);
  await app.topicAliases.remove('Alex Karp');
  assert.equal(app.getCachedStateGroups(state,'topic')[0].label,'Alex Karp');
});

test('closing a cached YouTube group skips navigated, loading and missing tabs',async()=>{
  const original='https://www.youtube.com/watch?v=abcdefghijk';
  const removed=[];
  const liveTabs=new Map([
    [1,{id:1,url:original,status:'complete'}],
    [2,{id:2,url:'https://www.youtube.com/watch?v=otherVideo1',status:'complete'}],
    [3,{id:3,url:'https://other.example/',status:'complete'}],
    [4,{id:4,url:original,status:'complete',pendingUrl:'https://other.example/'}],
    [5,{id:5,url:original,status:'loading'}]
  ]);
  const app=backgroundFixture(liveTabs,removed);await app.topicAliases.load();
  app.seed([1,2,3,4,5,6,1].map(tabId=>({title:'Alex Karp interview',channel:'Interviews',tabId,url:original})));
  const result=await app.handleCloseGroupTabs('topic','alex karp');
  assert.equal(result.closedTabs,1);assert.deepEqual(removed,[1]);assert.equal(liveTabs.size,4);
});

test('parked video titles receive specific local topics without loading a video',()=>{
  assert.equal(recognizeTopic('i installed omarchy linux and i will never go backI installed Omarchy Linux and i will never go back...'),'Omarchy');
  assert.equal(recognizeTopic('is omarchy 4 the worst linux distro?'),'Omarchy');
  assert.equal(recognizeTopic('Arch Linux installation guide'),'Arch Linux');
  assert.equal(recognizeTopic('archlinux setup'),'Arch Linux');
  assert.equal(recognizeTopic('Linux desktop guide'),'Linux');
  assert.equal(recognizeTopic('Python tutorials'),'Programmierung');
  assert.equal(recognizeTopic('ChatGPT tools'),'Künstliche Intelligenz');
  assert.equal(recognizeTopic('archaeology and the railway'),null);
  assert.equal(recognizeTopic('Omarchy Linux',[{alias:'Omarchy',target:'Mein Desktop'}]),'Mein Desktop');
});


test('Michael Every is recognized from explicit names regardless of title capitalization',()=>{
  for(const title of ['Michael Every interview','michael every on trade','MICHAEL EVERY: Market outlook','Michael J. Every discusses markets'])
    assert.equal(recognizeTopic(title),'Michael Every',title);
  for(const title of ['Every market reacts','Michael Everyday tips','Mike Every'])assert.equal(recognizeTopic(title),null,title);
});

test('Inbox examples use full names and a generic office does not identify a person',()=>{
  const fixtures=[
    ['Börsen-Beben! Spionage-Skandal schockt Trump. Mit Marie-Astrid Langer','Marie-Astrid Langer'],
    ['LIVE: Sec. Scott Bessent at The Forum 2026 — Building the American Economy for the Next 250 Years 37 Minuten','Scott Bessent'],
    ['LIVE: Treasury Secretary Speaks at Heritage Foundation’s The Forum 2026',null],
    ['Max Levchin, Founder & CEO @ Affirm:The Biggest Surprise Scaling to $18.7BN Market Cap','Max Levchin'],
    ['Max Levchin: “The Net IQ of the World Is About to Go Up 50 Points”','Max Levchin'],
    ['Nvidia is bigger than Jensen Huang','Jensen Huang']
  ];
  for(const [title,wants] of fixtures)assert.equal(recognizeTopic(title),wants,title);
});
