import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const playwright=require('playwright');
const profile=await mkdtemp(join(tmpdir(),'atelier-popup-'));
const language='en';
let browser;
try{
  browser=await playwright.chromium.launchPersistentContext(profile,{
    executablePath:process.env.CHROME_PATH||playwright.chromium.executablePath(),
    headless:true,locale:language,ignoreDefaultArgs:['--disable-extensions'],args:['--lang='+language,'--enable-unsafe-extension-debugging','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1']
  });
  await browser.route('https://*.test/**',route=>route.fulfill({contentType:'text/html',body:'<title>Example</title>'}));
  const session=await browser.browser().newBrowserCDPSession();
  const {id}=await session.send('Extensions.loadUnpacked',{path:resolve(process.env.ATELIER_TEST_EXTENSION||root)});
  const driver=await browser.newPage();
  await driver.goto('chrome-extension://'+id+'/dashboard.html');
  const urls=['https://news.test/a','https://books.test/b','https://notes.test/c','https://news.test/d'];
  const ids=await driver.evaluate(async urls=>{
    const ids=[];
    for(const url of urls)ids.push((await chrome.tabs.create({url,active:false})).id);
    return ids;
  },urls);
  const port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];
  async function popupAction(expression,command){
    let target;
    const find=async()=>(await session.send('Target.getTargets')).targetInfos.find(target=>target.url.endsWith('/popup.html'));
    if(!await find()){
      await driver.bringToFront();await driver.evaluate(()=>chrome.action.openPopup());
    }
    target=await find();assert.ok(target,'Expected a toolbar popup');
    const socket=new WebSocket('ws://127.0.0.1:'+port+'/devtools/page/'+target.targetId);
    try{
      await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
      const result=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('Popup did not reply')),8000);
        socket.onmessage=event=>{
          const msg=JSON.parse(event.data);if(msg.id!==1)return;
          clearTimeout(timer);resolve(msg);
        };
        socket.send(JSON.stringify(command?{id:1,...command}:{id:1,method:'Runtime.evaluate',params:{
          expression:'(async()=>{const $=id=>document.getElementById(id);for(let i=0;i<80&&!document.querySelector("[data-domain]");i++)await new Promise(r=>setTimeout(r,50));'+expression+'})()',awaitPromise:true,returnByValue:true
        }}));
      });
      assert.ok(!result.error&&!result.result?.exceptionDetails,JSON.stringify(result));
      return command?result.result:result.result.result.value;
    }finally{socket.close()}
  }
  assert.equal(await popupAction("return document.documentElement.lang"),language);
  assert.equal(await popupAction("return $('organizeView').textContent"),'Organize tabs');
  const visual=await popupAction(`const items=Array.from({length:120},(_,index)=>({domain:'example-'+index+'.test',count:1}));
    items[0]={domain:'video.example.test',count:64};items[1]={domain:'news.example.test',count:14};
    items[60]={domain:'a-very-long-domain-name-that-cannot-fit-in-one-line.example.test',count:10};
    domains=items;renderDomains();const content=$('popupContent');
    const check=(ok,msg)=>{if(!ok)throw Error(msg)};
    const bounds=el=>el.getBoundingClientRect();
    check(bounds(content).height>200,'Content is too short: '+bounds(content).height);
    check($('selectionBar').hidden,'Empty selection visible');
    for(const position of [0,60,119]){
      const view=rowsByDomain.get(items[position].domain);view.toggle.scrollIntoView({block:'center'});
      view.toggle.click();
      check(bounds(view.actions).bottom<=bounds(content).bottom+1,'Actions below viewport after click');
      view.close.focus();
      check(!view.actions.hidden&&view.close.getAttribute('aria-label').includes(String(items[position].count))&&view.close.getAttribute('aria-label').includes(items[position].domain),'Wrong close target');
      check(bounds(view.actions).top>=bounds(view.toggle).bottom,'Actions overlap their own row');
      check(bounds(view.actions).bottom<=bounds(view.row).bottom&&(!view.row.nextElementSibling||bounds(view.actions).bottom<=bounds(view.row.nextElementSibling).top),'Actions overlap next row');
      check($('domainList').querySelectorAll('.domain-actions:not([hidden])').length===1,'Multiple menus open');
      check(content.scrollWidth===content.clientWidth&&document.scrollingElement.scrollTop===0,'Overflow '+JSON.stringify({position,viewport:[innerWidth,innerHeight],rootScroll:document.scrollingElement.scrollTop,scrollWidth:content.scrollWidth,clientWidth:content.clientWidth,wide:[...content.querySelectorAll('*')].filter(el=>bounds(el).right>bounds(content).right).slice(0,8).map(el=>el.id||el.className)}));
    }
    const item=items[119],view=rowsByDomain.get(item.domain);
    view.checkbox.click();view.close.focus();item.count=11;
    domains=[item,...items.filter(entry=>entry!==item)];renderDomains();
    check(document.activeElement===view.close&&view.checkbox.checked&&!view.actions.hidden&&view.close.getAttribute('aria-label').includes('11'),'Refresh lost identity');
    view.close.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    check(view.actions.hidden&&document.activeElement===view.toggle,'Escape failed');
    view.checkbox.click();domains=items;renderDomains();
    $('domainScopeLabel').textContent=atelierI18n.t('ui_all_windows_7d53f7');
    const total=items.reduce((sum,item)=>sum+item.count,0);
    $('totalTabs').textContent=atelierI18n.t('popupTabCount',[total]);
    $('totalMeter').textContent=atelierI18n.t('totalMeterLabel',[total,atelierI18n.t('ui_off_2337c3')]);
    $('videoMeter').textContent='YouTube 18 / 20';
    rowsByDomain.get(items[0].domain).checkbox.click();rowsByDomain.get(items[1].domain).toggle.click();
    document.activeElement.blur();content.scrollTop=0;
    return {width:innerWidth,height:innerHeight,rows:rowsByDomain.size,scopeVisible:bounds($('domainsTitle')).top>=bounds(content).top};
  `);
  assert.equal(visual.rows,120);assert.equal(visual.scopeVisible,true);console.log(language,visual);
  if(process.env.ATELIER_PREVIEW_DIR){
    const shot=await popupAction('',{method:'Page.captureScreenshot',params:{format:'png'}});
    await mkdir(process.env.ATELIER_PREVIEW_DIR,{recursive:true});
    await writeFile(join(process.env.ATELIER_PREVIEW_DIR,'popup-'+language+'.png'),Buffer.from(shot.data,'base64'));
  }
  await popupAction('await refreshDomains()');
  assert.equal(await popupAction("$('videoMeter').click();return !$('rulesPane').hidden"),true);
  await popupAction("$('organizeView').click();document.querySelector('.sort-disclosure').open=true;$('sortDomainOrder').click()");
  async function finished(type){
    let result;
    for(let attempt=0;attempt<100;attempt++){
      result=await driver.evaluate(async type=>(await chrome.runtime.sendMessage({type:'get-tasks'})).tasks.find(task=>task.type===type),type);
      if(result&&!['queued','running'].includes(result.status))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(result?.status,'done',JSON.stringify(result)||type);
  }
  await finished('sort-window-domain');
  const tabs=()=>driver.evaluate(async ids=>Promise.all(ids.map(id=>chrome.tabs.get(id))),ids);
  const sorted=(await tabs()).sort((left,right)=>left.index-right.index);
  assert.deepEqual(sorted.map(tab=>tab.pendingUrl||tab.url),[urls[1],urls[0],urls[3],urls[2]]);
  await popupAction(`for(const domain of ['books.test','news.test']){
    const row=Array.from($('domainList').children).find(row=>row.querySelector('[data-domain]')?.dataset.domain===domain);
    row.querySelector('input').click();
  }
  $('moveSelected').click();`);
  await finished('domain-window');
  const moved=await tabs();
  assert.equal(moved[0].windowId,moved[1].windowId);assert.equal(moved[0].windowId,moved[3].windowId);
  assert.notEqual(moved[0].windowId,moved[2].windowId);
  await popupAction("document.querySelector('.sort-disclosure').open=true;$('sortDomainsNow').click()");await finished('manual-domain-routing');
  const separated=await tabs();
  assert.notEqual(separated[0].windowId,separated[1].windowId);
  assert.equal(separated[0].windowId,separated[3].windowId);
  assert.equal(await popupAction("return $('automaticDomainRouting').checked"),false);
  console.log('Popup: limits shortcut, alphabetical order, shared window and one-time domain routing passed.');
}finally{await browser?.close();await rm(profile,{recursive:true,force:true})}
