export function createActionQueue() {
  let tail = Promise.resolve();
  return task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
}
const queues = new WeakMap();
export function runExclusive(task, api = chrome) {
  if (!queues.has(api)) queues.set(api, createActionQueue());
  return queues.get(api)(task);
}
