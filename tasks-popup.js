(() => {
  const panel=document.getElementById('taskPanel'),list=document.getElementById('taskList');
  let timer;
  async function request(type,payload={}) {
    const response=await chrome.runtime.sendMessage({type,...payload});
    if(!response?.ok)throw Error(response?.error || globalThis.atelierI18n.t("ui_could_not_connect_to_the_extension_6ecfcb"));
    return response;
  }
  function render(tasks) {
    list.replaceChildren();
    panel.hidden=!tasks.length;
    for(const task of tasks.slice(-5).reverse()) {
      const row=document.createElement('li'),text=document.createElement('span');
      const active=['running','queued'].includes(task.status);
      const outcome={done:task.result?.warningCount?globalThis.atelierI18n.t("ui_done_with_warnings_c17e0e"):globalThis.atelierI18n.t("ui_done_25d52d"),cancelled:globalThis.atelierI18n.t("ui_cancelled_b9731e"),failed:globalThis.atelierI18n.t("ui_error_f6cc01"),interrupted:globalThis.atelierI18n.t("ui_interrupted_d8135c"),queued:globalThis.atelierI18n.t("ui_queued_cff729"),running:task.phase}[task.status];
      text.textContent=`${task.label}: ${outcome} · ${task.processed}/${task.total}${task.result?.inboxSaved!==undefined?globalThis.atelierI18n.t("ui_videos_saved_efbc49", [task.result.inboxSaved, task.type==='inbox-capture'?globalThis.atelierI18n.t("ui_tabs_closed_7f820a", [task.result.closedTabs||0]):'']):''}${task.error?` · ${task.error}`:''}${task.result?.skipped?globalThis.atelierI18n.t("ui_skipped_3f817b", [task.result.skipped]):''}${['domain-window','move-group-to-window'].includes(task.type)&&task.result?.movedTabs!==undefined?` · ${task.result.movedTabs} ${task.type==='move-group-to-window'?globalThis.atelierI18n.t("ui_processed_14493b"):globalThis.atelierI18n.t("ui_moved_e0a2d9")}${task.type==='move-group-to-window'?globalThis.atelierI18n.t("ui_grouped_43af80", [task.result.groupedTabs||0]):''}`:''}`;
      row.append(text);
      if(task.type==='inbox-open-batch'&&task.result)text.textContent+=globalThis.atelierI18n.t("ui_newly_opened_reused_grouped_5ec8b5", [task.result.createdTabs||0, task.result.reusedTabs||0, task.result.groupedTabs||0]);
      if(task.result?.duplicatesClosed)text.textContent+=globalThis.atelierI18n.t("ui_duplicate_videos_closed_b48298", [task.result.duplicatesClosed]);
      if(task.errors?.length) {
        const details=document.createElement('details'),summary=document.createElement('summary'),notes=document.createElement('ul');
        summary.textContent=globalThis.atelierI18n.t("ui_warnings_a29594", [task.result?.warningCount||task.errors.length]);
        for(const issue of task.errors) {const li=document.createElement('li');li.textContent=issue.message||String(issue);notes.append(li)}
        details.append(summary,notes);row.append(details);
      }
      if(active || task.result?.exportReady || task.canResume) {
        const button=document.createElement('button');button.className='row-button';button.type='button';
        button.textContent=active?(task.cancelRequested?globalThis.atelierI18n.t("ui_cancelling_8e02e5"):globalThis.atelierI18n.t("ui_cancel_f7ff11")):task.canResume?globalThis.atelierI18n.t("ui_resume_76f6db"):globalThis.atelierI18n.t("ui_save_json_ffd67c");
        button.disabled=!!task.cancelRequested;
        button.addEventListener('click',async()=>{
          button.disabled=true;
          try {await request(active?'cancel-task':task.canResume?'resume-task':'download-export',{taskId:task.id});await refresh();}
          catch(error){text.textContent=error.message;button.disabled=false;}
        });row.append(button);
      }
      list.append(row);
    }
  }
  async function refresh() {
    clearTimeout(timer);
    try {
      const response=await request('get-tasks');render(response.tasks);
      if(response.tasks.some(t=>['running','queued'].includes(t.status)))timer=setTimeout(refresh,700);
    } catch(error) { panel.hidden=false;list.textContent=error.message; }
  }
  async function send(type,payload={}) {
    const first=await request(type,payload);
    if(!first.taskId || first.exportReady)return first;
    await refresh();
    for(;;) {
      const {tasks}=await request('get-tasks');render(tasks);
      const task=tasks.find(t=>t.id===first.taskId);
      if(!task)throw Error(globalThis.atelierI18n.t("ui_task_no_longer_available_7f7ade"));
      if(task.status==='done')return task.result;
      if(['failed','interrupted','cancelled'].includes(task.status))throw Error(globalThis.atelierI18n.t("ui_steps_processed_63aa5e", [task.error || globalThis.atelierI18n.t("ui_cancelled_f629eb"), task.processed, task.total]));
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  window.atelierTasks={send};
  chrome.runtime.onMessage.addListener(message=>{if(message?.type==='tasks-changed')refresh()});
  window.addEventListener('unload',()=>clearTimeout(timer));
  refresh();
})();
