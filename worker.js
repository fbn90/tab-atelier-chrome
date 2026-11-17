import {inbox} from './background.js';
import {flushTabManagerEvents,flushTabManagerEventsInAction} from './tab-manager.js';
import {installTabAutomation} from './tab-automation.js';
chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'})?.catch(console.warn);
installTabAutomation(chrome,{inbox,flushEvents:flushTabManagerEvents,flushEventsInAction:flushTabManagerEventsInAction});
