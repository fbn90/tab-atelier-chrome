const PREFIX = 'ytMetadataV2:';
const LEGACY = 'ytVideoMetadataCacheV1';
const MIGRATED = 'ytMetadataMigratedV2';
const SHARDS = 32, PER_SHARD = 125, MEMORY_SHARDS = 8;
const TTL = 30 * 24 * 60 * 60 * 1000;
const shardOf = id => [...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % SHARDS;
const keys = Array.from({ length: SHARDS }, (_, i) => PREFIX + i);
const fresh = record => record && typeof record.channel === 'string' && Number.isFinite(record.updatedAt) &&
  record.updatedAt <= Date.now() && Date.now() - record.updatedAt < (record.ttl || TTL);
const compact = entries => {
  const result = {}; let bytes=2;
  for (const [id, value] of Object.entries(entries || {}).filter(([,value])=>fresh(value)).sort((a,b)=>b[1].updatedAt-a[1].updatedAt)) {
    const size=new TextEncoder().encode(JSON.stringify({[id]:value})).length;
    if(Object.keys(result).length>=PER_SHARD || bytes+size>128*1024)break;
    result[id]=value;bytes+=size;
  }
  return result;
};

export function createMetadataCache(storage) {
  const memory = new Map(), dirty = new Set();
  let migrated = false, queue = Promise.resolve(), lastError = null, revision = 0;
  function serialize(fn) {
    const task = queue.then(fn).catch(error => { lastError = error.message; throw error; });
    queue = task.catch(() => {}); return task;
  }
  async function flush() {
    const updates = {};
    for (const shard of dirty) updates[PREFIX + shard] = memory.get(shard);
    if (dirty.size) { await storage.set(updates); dirty.clear(); }
    lastError = null;
  }
  async function migrate() {
    if (migrated) return;
    const stored = await storage.get([MIGRATED, LEGACY]);
    if (!stored[MIGRATED] && stored[LEGACY]) {
      // V1 records did not verify the DOM's video ID. Revalidate them once.
      await storage.remove(LEGACY);
    }
    if (!stored[MIGRATED]) await storage.set({ [MIGRATED]: true });
    migrated = true;
  }
  async function bucket(shard) {
    await migrate();
    if (memory.has(shard)) {
      const value = memory.get(shard); memory.delete(shard); memory.set(shard, value); return value;
    }
    if (memory.size >= MEMORY_SHARDS) { await flush(); memory.delete(memory.keys().next().value); }
    const key = PREFIX + shard;
    const stored = (await storage.get(key))[key] || {};
    const value = compact(stored);
    if (Object.keys(stored).length !== Object.keys(value).length) dirty.add(shard);
    memory.set(shard, value); return value;
  }
  return {
    get revision() { return revision; },
    get error() { return lastError; },
    get(id) { return serialize(async () => { const value = (await bucket(shardOf(id)))[id]; return fresh(value) ? { ...value } : null; }); },
    getMany(ids) { return serialize(async () => {
      const groups = new Map(), result = new Map();
      for (const id of new Set(ids)) { const shard = shardOf(id); if (!groups.has(shard)) groups.set(shard, []); groups.get(shard).push(id); }
      for (const [shard, ids] of groups) {
        const value = await bucket(shard);
        for (const id of ids) if (fresh(value[id])) result.set(id, { ...value[id] });
      }
      await flush(); return result;
    }); },
    set(id, value, expectedRevision = revision) { return serialize(async () => {
      if (expectedRevision !== revision) return;
      const shard = shardOf(id), contents = await bucket(shard);
      contents[id] = { title: String(value.title || '').slice(0, 1000), channel: String(value.channel || 'Unbekannt').slice(0, 300),
        ...(value.channelKey?{channelKey:value.channelKey}:{}),...(value.channelHandle?{channelHandle:value.channelHandle}:{}),
        updatedAt: Date.now(), ttl: !value.title || value.channel === 'Unbekannt' ? 5 * 60 * 1000 : TTL };
      memory.set(shard, compact(contents)); dirty.add(shard);
    }); },
    flush() { return serialize(flush); },
    clear() { return serialize(async () => {
      revision++; memory.clear(); dirty.clear();
      await storage.remove([...keys, LEGACY]);
      await storage.set({ [MIGRATED]: true }); migrated = true; lastError = null;
    }); },
    stats() { return serialize(async () => {
      await migrate(); await flush();
      const stored = await storage.get(keys);
      let entries = 0;
      const updates = {};
      for (const key of keys) {
        const before = stored[key] || {}, after = compact(before);
        entries += Object.keys(after).length;
        if (Object.keys(before).length !== Object.keys(after).length) updates[key] = after;
      }
      if (Object.keys(updates).length) await storage.set(updates);
      const bytes = await storage.getBytesInUse(keys);
      return { entries, bytes, maxEntries: SHARDS * PER_SHARD, memoryShards: memory.size, error: lastError };
    }); }
  };
}
