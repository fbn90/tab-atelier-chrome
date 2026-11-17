import './i18n.js';
import { resumableTransfer } from "./tab-transfer.js";
import { isTrustedPage } from "./extension-pages.js";
import { runExclusive } from './action-coordinator.js';
const KEY = 'atelierTasksV1';
const ALARM = 'atelier-task-continuation';
const ACTIVE = new Set(['queued', 'running']);
const isReview=task=>task?.type==='inbox-review-open';
const canRecover=task=>isReview(task)||resumableTransfer(task);
const canRetry=task=>canRecover(task)&&(['failed','interrupted'].includes(task.status)||isReview(task)&&task.status==='cancelled');

export function createTaskService(api, { schedule = callback => setTimeout(callback, 25) } = {}) {
  const handlers = new Map(), cancelled = new Set();
  let state, loading, scheduled = false, pumping = false;
  async function load() {
    if (state) return;
    if (!loading) loading = (async () => {
      const stored = await api.storage.session.get(null);
      const retired = (stored[KEY]?.tasks || []).filter(task => task.type === 'onetab-close');
      const retiredIds = new Set(retired.map(task => task.id));
      const obsolete = Object.keys(stored).filter(key => key.startsWith('oneTabTransferV1:') ||
        (key.startsWith(KEY + ':') && retiredIds.has(key.split(':')[1])));
      if (obsolete.length) await api.storage.session.remove(obsolete);
      if (retiredIds.size) {
        stored[KEY].tasks = stored[KEY].tasks.filter(task => !retiredIds.has(task.id));
        stored[KEY + 'Cancel'] = (stored[KEY + 'Cancel'] || []).filter(id => !retiredIds.has(id));
        await api.storage.session.set({ [KEY]: stored[KEY], [KEY + 'Cancel']: stored[KEY + 'Cancel'] });
      }
      state = stored[KEY] || { tasks: [] };
      for (const id of stored[KEY + 'Cancel'] || []) cancelled.add(id);
      for (const task of state.tasks) if (task.inFlight && ACTIVE.has(task.status)) {
        if(canRecover(task)) {task.inFlight=false;task.phase=globalThis.atelierI18n.t("ui_checking_move_progress_847fc9");continue;}
        task.status = 'interrupted';
        task.error = globalThis.atelierI18n.t("ui_interrupted_during_a_tab_action_completed_steps_are_80a6df");
      }
    })();
    await loading;
  }
  const save = () => api.storage.session.set({ [KEY]: state, [KEY + "Cancel"]: [...cancelled] });
  function notify() { api.runtime.sendMessage({ type: 'tasks-changed' }).catch(() => {}); }
  function kick() {
    if (scheduled || pumping) return;
    scheduled = true;
    schedule(() => { scheduled = false; pump().catch(error => console.warn(globalThis.atelierI18n.t("ui_task_9938af"), error)); });
  }
  function publicTask(task) {
    if (!task) return null;
    const { id, type, label, status, processed = 0, total = 0, phase, result, error, errors = [], updatedAt } = task;
    return { id, type, label, status, processed, total, phase, result, error, errors, updatedAt, canResume: canRetry(task), cancelRequested: cancelled.has(task.id) };
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      await runExclusive(async () => {
        await load();
        const task = state.tasks.find(t => ACTIVE.has(t.status));
        if (!task) { await api.alarms?.clear(ALARM); return; }
        const handler = handlers.get(task.type);
        if (!handler) return;
        task.status = 'running';
        const context = {
          cancelled: () => cancelled.has(task.id),
          checkpoint: save,
          read: async (name = 'data') => (await api.storage.session.get(`${KEY}:${task.id}:${name}`))[`${KEY}:${task.id}:${name}`],
          write: async (value, name = 'data') => {
            const key = `${KEY}:${task.id}:${name}`;
            task.keys ??= [];
            if (!task.keys.includes(key)) task.keys.push(key);
            await api.storage.session.set({ [key]: value, [KEY]: state });
          },
          effect: async fn => {
            if (cancelled.has(task.id)) return false;
            task.inFlight = true;
            await save(); // Never perform a mutation without a durable intent.
            if(cancelled.has(task.id)) {task.inFlight=false;await save();return false;}
            try { await fn(); }
            finally { task.inFlight = false; await save(); }
            return true;
          }
        };
        try {
          if (context.cancelled()) task.status = 'cancelled';
          else if (await handler(task, context)) task.status = 'done';
          if (context.cancelled() && task.status !== 'done') task.status = 'cancelled';
        } catch (error) {
          task.status = 'failed';
          task.error = error.message || String(error);
        }
        task.updatedAt = Date.now();
        if (!ACTIVE.has(task.status) && !canRetry(task) && !(task.type === 'export-watch-tabs' && task.status === 'done')) {
          await api.storage.session.remove(task.keys || []);task.keys=[];
        }
        await save();
        notify();
      }, api);
    } finally {
      pumping = false;
      if (state?.tasks.some(t => ACTIVE.has(t.status))) kick();
      else await api.alarms?.clear(ALARM);
    }
  }
  return {
    register(type, handler) { handlers.set(type, handler); },
    async start(type, payload = {}, label = type) {
      return runExclusive(async () => {
        await load();
        if (!handlers.has(type)) throw Error(globalThis.atelierI18n.t("ui_unknown_task_c95351"));
        if (state.tasks.filter(t => ACTIVE.has(t.status)).length >= 5) throw Error(globalThis.atelierI18n.t("ui_please_finish_the_running_tasks_first_455dbc"));
        const obsolete = state.tasks.filter(t => !ACTIVE.has(t.status) && !t.downloadPending).slice(0, -4);
        for (const task of obsolete) {
          await api.storage.session.remove(task.keys || []);
          state.tasks.splice(state.tasks.indexOf(task), 1);
          cancelled.delete(task.id);
        }
        const id = crypto.randomUUID();
        state.tasks.push({ id, type, label, payload, status: 'queued', phase: globalThis.atelierI18n.t("ui_preparing_64dfc2"), cursor: 0, processed: 0, total: 0, keys: [], updatedAt: Date.now() });
        await save();
        await api.alarms?.create(ALARM, { periodInMinutes: 0.5 });
        kick();
        return { ok: true, taskId: id };
      }, api);
    },
    async list() { await load(); kick(); return { ok: true, tasks: state.tasks.map(publicTask) }; },
    async retry(id) {
      return runExclusive(async()=>{
        await load();
        const task=state.tasks.find(t=>t.id===id);
        if(!task || !canRetry(task))throw Error(globalThis.atelierI18n.t("ui_this_task_cannot_be_resumed_712d99"));
        if(state.tasks.filter(t=>ACTIVE.has(t.status)).length>=5)throw Error(globalThis.atelierI18n.t("ui_please_finish_the_running_tasks_first_455dbc"));
        cancelled.delete(task.id);
        task.status='queued';task.error=null;task.inFlight=false;task.phase=globalThis.atelierI18n.t("ui_checking_move_progress_847fc9");
        await save();await api.alarms?.create(ALARM,{periodInMinutes:0.5});kick();return {ok:true,taskId:id};
      },api);
    },
    async cancel(id) {
      await load();
      if (!state.tasks.some(t => t.id === id && ACTIVE.has(t.status))) return { ok: true };
      cancelled.add(id);
      await api.storage.session.set({ [KEY + 'Cancel']: [...cancelled] });
      kick(); return { ok: true };
    },
    async data(id, name = 'data') {
      await load();
      const task = state.tasks.find(t => t.id === id);
      if (!task) throw Error(globalThis.atelierI18n.t("ui_task_no_longer_available_7f7ade"));
      const key = `${KEY}:${id}:${name}`;
      return { task, value: (await api.storage.session.get(key))[key] };
    },
    save, pump,
    async resume() { await load(); if (state.tasks.some(t => ACTIVE.has(t.status))) { await api.alarms?.create(ALARM, { periodInMinutes: 0.5 }); kick(); } else await api.alarms?.clear(ALARM); }
  };
}
const services = new WeakMap();
export function taskService(api = chrome) {
  if (!services.has(api)) {
    const service = createTaskService(api);
    services.set(api, service);
    api.alarms?.onAlarm.addListener(alarm => { if (alarm.name === ALARM) service.pump().catch(console.warn); });
    api.runtime.onMessage.addListener((message, sender, reply) => {
      if (!['get-tasks', 'cancel-task', 'resume-task'].includes(message?.type)) return false;
      if (!isTrustedPage(sender, api)) {
        reply({ ok: false, error: globalThis.atelierI18n.t("ui_unauthorized_message_source_674efb") }); return false;
      }
      (message.type === 'get-tasks' ? service.list() : message.type==='resume-task'?service.retry(message.taskId):service.cancel(message.taskId))
        .then(reply, error => reply({ ok: false, error: error.message }));
      return true;
    });
  }
  return services.get(api);
}
