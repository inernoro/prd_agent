// Runs in mongosh against the local production Mongo container. No credentials printed.
// StartedAt is stored as an ISO string by MAP; a Mongo TTL index would not expire it.
function retentionFilter(cutoff) {
  return {$or: [{StartedAt: {$type: 'string', $lt: cutoff.toISOString()}},
                {StartedAt: {$type: 'date', $lt: cutoff}}]};
}

async function retainRequestLogs(database, options) {
  const {days = 30, batchSize = 1000, maxBatches = 100, maxSeconds = 120,
         execute = false, now = new Date()} = options;
  if (!Number.isInteger(days) || days < 7 || days > 365 ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000 ||
      !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 2000 ||
      !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 600) {
    throw new Error('Invalid bounded request-log retention settings');
  }
  const collection = database.getCollection('apirequestlogs');
  const indexes = await collection.getIndexes();
  if (!indexes.some(i => Object.keys(i.key).length === 1 && i.key.StartedAt)) {
    throw new Error('StartedAt index required before log cleanup');
  }
  const cutoff = new Date(now.getTime() - days * 86400000);
  const filter = retentionFilter(cutoff);
  const start = Date.now();
  let deleted = 0, batches = 0, candidates = 0;
  for (; batches < maxBatches && Date.now() - start < maxSeconds * 1000; batches++) {
    const rows = await collection.find(filter, {_id: 1}).sort({StartedAt: 1})
      .limit(batchSize).maxTimeMS(10000).toArray();
    if (!rows.length) break;
    candidates += rows.length;
    if (!execute) break;
    const result = await collection.deleteMany({$and: [filter, {_id: {$in: rows.map(x => x._id)}}]},
                                              {maxTimeMS: 10000});
    deleted += result.deletedCount;
    if (result.deletedCount === 0) break;
    // Bound write pressure so application traffic stays responsive.
    if (typeof sleep === 'function') await sleep(100);
  }
  const remaining = await collection.find(filter, {_id: 1}).limit(1).maxTimeMS(10000).toArray();
  return {database: database.getName(), collection: 'apirequestlogs', cutoff: cutoff.toISOString(),
          days, execute, deleted, sampledCandidates: candidates, batches,
          backlog: remaining.length > 0, elapsedMs: Date.now() - start};
}

if (typeof module !== 'undefined') module.exports = {retentionFilter, retainRequestLogs};
if (typeof db !== 'undefined') {
  // Database allowlist is intentional: never infer it from a container's default database.
  retainRequestLogs(db.getSiblingDB('prdagent'), {
    days: Number(process.env.PRD_LOG_RETENTION_DAYS || 30),
    batchSize: Number(process.env.PRD_LOG_RETENTION_BATCH_SIZE || 1000),
    maxBatches: Number(process.env.PRD_LOG_RETENTION_MAX_BATCHES || 100),
    maxSeconds: Number(process.env.PRD_LOG_RETENTION_MAX_SECONDS || 120),
    execute: process.env.PRD_LOG_RETENTION_EXECUTE === '1'
  }).then(result => print(JSON.stringify(result))).catch(error => {
    print('Request log retention failed: ' + error.message);
    quit(1);
  });
}
