export function memoryStorage(initial={}) {
  const data=structuredClone(initial),writes=[];
  return {data,writes,
    async get(keys) {
      if(keys==null)return structuredClone(data);
      const defaults=typeof keys==='object'&&!Array.isArray(keys)?keys:{};
      const names=typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys);
      return Object.fromEntries(names.map(key=>[key,structuredClone(data[key]??defaults[key])]));
    },
    async set(value){writes.push(structuredClone(value));Object.assign(data,structuredClone(value))},
    async remove(keys){for(const key of [keys].flat())delete data[key]},
    async getBytesInUse(keys){return Buffer.byteLength(JSON.stringify(await this.get(keys)))}
  };
}
export function event(){const listeners=[];return {listeners,addListener(fn){listeners.push(fn)},fire(...args){for(const fn of listeners)fn(...args)}}}
