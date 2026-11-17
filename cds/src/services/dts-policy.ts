import { createHash, randomUUID } from 'node:crypto';
import { MongoClient, Long, BSON } from 'mongodb';
import type { DtsActor, DtsConnection, DtsContract, DtsFieldType, DtsMode, DtsPlan } from '../shared/dts.js';

export class DtsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function dtsReject(code: string, message: string, status = 400): never { throw new DtsError(status, code, message); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const dtsHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(BSON.EJSON.stringify(value, { relaxed: false }))))).digest('hex');
const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const deniedFields = /password|secret|token|session|credential|api.?key|migration|instance.?id/i;
const types = new Set<DtsFieldType>(['string', 'boolean', 'int', 'bigint', 'double', 'timestamp']);
export function dtsText(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) dtsReject('invalid_input', `请填写有效的${label}`);
  return value.trim();
}
export function parseDtsContract(input: unknown): DtsContract {
  const c = input as DtsContract;
  if (!c || typeof c !== 'object' || !Number.isSafeInteger(c.version) || c.version < 1
    || !Array.isArray(c.accepts) || !c.accepts.length || c.accepts.length > 20 || c.accepts.some(v => !Number.isSafeInteger(v) || v < 1)
    || !c.fields || Array.isArray(c.fields) || Object.keys(c.fields).length > 50 || c.fields._id !== 'string') {
    dtsReject('invalid_contract', '请登记有效的数据版本、可接收版本和文本主键');
  }
  for (const [field, type] of Object.entries(c.fields)) {
    if (!fieldPattern.test(field) || ['__proto__', 'prototype', 'constructor'].includes(field) || !types.has(type) || deniedFields.test(field)) {
      dtsReject('unsupported_field', '所选字段包含未支持的类型或受保护资料，请缩小同步范围');
    }
  }
  return { id: dtsText(c.id, '数据契约标识'), version: c.version, accepts: [...new Set(c.accepts)], fields: { ...c.fields } };
}
export function parseDtsConnection(projectId: string, input: unknown): DtsConnection {
  const c = input as DtsConnection;
  if (!c || !['mongo', 'redis', 'mysql', 'postgres', 'rabbitmq'].includes(c.kind)) dtsReject('invalid_connection', '请选择数据服务类型');
  const uriEnv = dtsText(c.uriEnv, '已有连接配置名称');
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(uriEnv)) dtsReject('invalid_connection', '请选择有效的已有连接配置');
  const database = dtsText(c.database, '数据库名称', 63), collection = dtsText(c.collection, '数据集合名称', 100);
  if (!/^[A-Za-z0-9_-]+$/.test(database) || !/^[A-Za-z0-9_-]+$/.test(collection) || /^(admin|config|local)$/i.test(database)
    || collection.startsWith('system')) dtsReject('invalid_namespace', '请选择业务数据库和数据集合，不可同步系统库');
  const environmentRole = c.environmentRole ?? 'other';
  if (!['production', 'standby', 'acceptance', 'other'].includes(environmentRole) || (c.allowWrite !== undefined && typeof c.allowWrite !== 'boolean')) dtsReject('invalid_environment', '请明确环境角色与是否允许作为写入目标');
  const contract = parseDtsContract(c.contract);
  const accountFields = c.accountFields ?? [];
  if (!Array.isArray(accountFields) || accountFields.some(f => f === '_id' || !Object.hasOwn(contract.fields, f) || deniedFields.test(f)
    || /^(status|roles?|permissions?|disabled|active|isSystemOwner|isAdmin|authProvider)$/i.test(f))) {
    dtsReject('invalid_account_fields', '账号校准字段必须来自已批准的数据字段，不能包含身份主键或凭据');
  }
  return { id: randomUUID(), projectId, ...(c.infraId !== undefined ? { infraId: dtsText(c.infraId, '项目数据服务') } : {}), kind: c.kind, name: dtsText(c.name, '连接名称'), uriEnv, database, collection,
    contract, environmentRole, allowWrite: c.allowWrite === true, accountFields: [...new Set(accountFields)], createdAt: new Date().toISOString() };
}
export function dtsConnectionUri(connection: DtsConnection, env: Record<string, string | undefined>): string {
  const uri = env[connection.uriEnv];
  if (!uri || !(connection.kind === 'mongo' ? /^mongodb(?:\+srv)?:\/\// : connection.kind === 'rabbitmq' ? /^https?:\/\// : connection.kind === 'redis' ? /^redis:\/\// : connection.kind === 'mysql' ? /^mysql:\/\// : /^(?:postgres|postgresql):\/\//).test(uri)) dtsReject('connection_unavailable', '已有数据库连接不可用，请联系管理员核对服务配置', 503);
  return uri;
}
export function compatibleDtsFields(source: DtsConnection, target: DtsConnection, mode: DtsMode, accountPolicy = false): Record<string, DtsFieldType> {
  // Policies keep their authority/whitelist checks, but missing rows need the
  // complete approved insert contract rather than the daily update subset.
  if (accountPolicy && mode !== 'account-authority') compatibleDtsFields(source, target, 'account-authority');
  if (!target.allowWrite) dtsReject('target_read_only', '该连接未获准作为写入目标，请由管理员核对后登记', 403);
  if (mode === 'account-authority' && (source.environmentRole !== 'production' || target.environmentRole === 'production')) dtsReject('account_direction_invalid', '账号资料必须由已登记的正式环境向非正式环境同步，不能反向覆盖正式资料', 409);
  if (source.kind !== target.kind || !['mongo', 'mysql', 'postgres', 'redis', 'rabbitmq'].includes(source.kind)) dtsReject('connector_not_verified', '该服务连接器尚未完成本环境验证，暂不允许写入', 409);
  if (['redis','rabbitmq'].includes(source.kind) && source.collection !== target.collection) dtsReject('prefix_mapping_not_verified','源和目标必须使用相同的批准前缀，尚未开放跨前缀重命名写入',409);
  if (source.contract.id !== target.contract.id || !target.contract.accepts.includes(source.contract.version)) {
    dtsReject('incompatible_version', '两端数据版本尚未确认兼容，请先完成版本映射或升级目标环境', 409);
  }
  const selected = mode === 'account-authority' ? ['_id', ...target.accountFields] : Object.keys(source.contract.fields);
  if (mode === 'account-authority' && !target.accountFields.length) dtsReject('account_fields_required', '请先由管理员选择允许校准的账号字段');
  const result: Record<string, DtsFieldType> = {};
  for (const field of selected) {
    if (!Object.hasOwn(source.contract.fields, field) || source.contract.fields[field] !== target.contract.fields[field]) {
      dtsReject('incompatible_field', '两端选定字段的类型不一致，请先完成结构映射', 409);
    }
    result[field] = source.contract.fields[field];
  }
  return result;
}
function matchesType(value: unknown, type: DtsFieldType): boolean {
  if (value === null || value === undefined) return true;
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'timestamp') return value instanceof Date;
  if (type === 'bigint') return Long.isLong(value) || (typeof value === 'number' && Number.isSafeInteger(value));
  if (type === 'int') return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  return typeof value === 'number' && Number.isFinite(value);
}
export async function withDtsMongo<T>(uri: string, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000, socketTimeoutMS: 10_000, maxPoolSize: 2, promoteLongs: false });
  try { await client.connect(); return await fn(client); } finally { await client.close().catch(() => undefined); }
}
async function namespaceFingerprint(client: MongoClient, c: DtsConnection, uri: string): Promise<{ identity: string; fingerprint: string }> {
  const hello = await client.db('admin').command({ hello: 1 });
  const identity = dtsHash({ setName: hello.setName ?? null, hosts: hello.hosts?.sort(), process: hello.setName ? null : String(hello.topologyVersion?.processId ?? '') });
  const info = await client.db(c.database).listCollections({ name: c.collection }, { nameOnly: false }).next();
  if (!info) dtsReject('namespace_missing', '选定的数据集合尚未建立，请先完成环境初始化或结构迁移', 409);
  const indexes = info ? await client.db(c.database).collection(c.collection).listIndexes().toArray() : [];
  return { identity: `${identity}/${c.database}/${c.collection}`, fingerprint: dtsHash({ identity, uriDigest: dtsHash(uri), connection: c, options: info?.options ?? {}, indexes }) };
}
/** The guard computes missing stable IDs; all record writes are performed by SeaTunnel's original MongoDB sink. */
export async function prepareDtsPlan(input: {
  projectId: string; source: DtsConnection; target: DtsConnection; sourceUri: string; targetUri: string;
  mode: DtsMode; actor: DtsActor; planId?: string; profileOnly?: boolean; maxRecords?: number;
}): Promise<DtsPlan> {
  const { source, target, mode } = input;
  if (mode !== 'append-only' && mode !== 'account-authority') dtsReject('invalid_mode', '请选择只追加或账号资料校准');
  const fields = compatibleDtsFields(source, target, mode, input.profileOnly);
  return withDtsMongo(input.sourceUri, a => withDtsMongo(input.targetUri, async b => {
    const sourceMeta = await namespaceFingerprint(a, source, input.sourceUri), targetMeta = await namespaceFingerprint(b, target, input.targetUri);
    if (sourceMeta.identity === targetMeta.identity) dtsReject('same_dataset', '源和目标实际指向同一份数据，请选择独立的目标环境', 409);
    const src = a.db(source.database).collection<Record<string, unknown> & { _id: string }>(source.collection);
    const dst = b.db(target.database).collection<Record<string, unknown> & { _id: string }>(target.collection);
    const max = input.maxRecords ?? 10_000;
    const projection = Object.fromEntries(Object.keys(fields).map(field => [field, 1]));
    const records: Record<string, unknown>[] = []; let selectedBytes = 0;
    const cursor = src.find({}, { projection, maxTimeMS: 10_000 }).sort({ _id: 1 }).limit(max + 1);
    try { for await (const row of cursor) {
      if (records.length >= max) dtsReject('selection_too_large', '本次选定数据超过已验证的批次容量，请缩小范围后分批同步', 409);
      if (typeof row._id !== 'string' || !row._id || row._id.length > 200) dtsReject('identity_type_not_verified', '该集合的主键类型或长度尚未通过无损传输验证，已阻止写入', 409);
      for (const [field, type] of Object.entries(fields)) if (!Object.hasOwn(row, field) || !matchesType(row[field], type)) dtsReject('schema_drift', '实际数据与登记结构不一致或缺少选定字段，请重新检查数据版本和字段映射', 409);
      selectedBytes += BSON.calculateObjectSize(row);
      if (selectedBytes > 8 * 1024 * 1024) dtsReject('selection_too_large', '本次数据超过已验证的内存预算，请缩小范围后分批同步', 409);
      records.push(row);
    } } finally { await cursor.close(); }
    const stats = await b.db(target.database).command({ dbStats: 1, scale: 1 });
    const total = Number(stats.fsTotalSize), used = Number(stats.fsUsedSize);
    const targetFreeBytes = total - used, requiredFreeBytes = Math.ceil(selectedBytes * 4) + 256 * 1024 * 1024;
    if (!Number.isFinite(total) || !Number.isFinite(used) || targetFreeBytes < requiredFreeBytes) {
      dtsReject('capacity_unavailable', '目标可用空间不足或无法可靠核实，已阻止写入；请检查存储容量', 409);
    }
    const keys = records.map(row => String(row._id));
    const existing = keys.length ? await dst.find({ _id: { $in: keys as never[] } }, { projection: { _id: 1 }, maxTimeMS: 10_000 }).toArray() : [];
    const existingKeys = new Set(existing.map(row => String(row._id)));
    if (mode === 'account-authority' && records.length !== existing.length) dtsReject('new_accounts_require_append', '目标仍有尚未同步的账号，请先使用只追加缺失项补齐，再校准账号资料', 409);
    const selected = mode === 'append-only' ? records.filter(row => !existingKeys.has(String(row._id))) : records;
    return { id: input.planId ?? randomUUID(), projectId: input.projectId, sourceId: source.id, targetId: target.id, mode, profileOnly: input.profileOnly,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      sourceFingerprint: sourceMeta.fingerprint, targetFingerprint: targetMeta.fingerprint, fields,
      sourceCount: records.length, targetCount: await dst.estimatedDocumentCount({ maxTimeMS: 5_000 }),
      insertCount: records.length - existing.length, updateCount: mode === 'account-authority' ? existing.length : 0,
      skipCount: mode === 'append-only' ? existing.length : 0,
      selectedBytes, targetFreeBytes, requiredFreeBytes,
      keys: selected.map(row => String(row._id)), selectedDigest: dtsHash(selected), approvedBy: input.actor,
      sourceContract: source.contract, targetContract: target.contract };
  }));
}
export function buildDtsMongoJob(plan: DtsPlan, source: DtsConnection, target: DtsConnection, sourceUri: string, targetUri: string): Record<string, unknown> {
  if (!plan.keys.length) dtsReject('empty_plan', '没有需要同步的记录，请先重新比较');
  return { env: { 'job.mode': 'BATCH', parallelism: 1, 'job.name': `cds-dts-${plan.id}`, 'job.retry.times': 0 },
    source: [{ plugin_name: 'MongoDB', uri: sourceUri, database: source.database, collection: source.collection,
      'match.query': JSON.stringify({ _id: { $in: plan.keys } }), 'match.projection': JSON.stringify(Object.fromEntries(Object.keys(plan.fields).map(k => [k, 1]))),
      schema: { fields: plan.fields }, 'fetch.size': 100, 'max.time-min': 5 }],
    sink: [{ plugin_name: 'MongoDB', uri: targetUri, database: target.database, collection: target.collection,
      'upsert-enable': plan.mode === 'account-authority', 'primary-key': ['_id'], 'retry.max': 0,
      'buffer-flush.max-rows': 100, transaction: false }] };
}
export async function verifyDtsPlan(plan: DtsPlan, source: DtsConnection, target: DtsConnection, sourceUri: string, targetUri: string): Promise<number> {
  return withDtsMongo(sourceUri, a => withDtsMongo(targetUri, async b => {
    const sourceMeta = await namespaceFingerprint(a, source, sourceUri), targetMeta = await namespaceFingerprint(b, target, targetUri);
    if (sourceMeta.fingerprint !== plan.sourceFingerprint || targetMeta.fingerprint !== plan.targetFingerprint) {
      dtsReject('verification_mismatch', '传输期间连接或结构已变化，结果未通过对账，请核对后重新比较', 409);
    }
    const projection = Object.fromEntries(Object.keys(plan.fields).map(k => [k, 1]));
    const query = { _id: { $in: plan.keys as never[] } };
    const src = await a.db(source.database).collection(source.collection).find(query, { projection, maxTimeMS: 10_000 }).sort({ _id: 1 }).toArray();
    const dst = await b.db(target.database).collection(target.collection).find(query, { projection, maxTimeMS: 10_000 }).sort({ _id: 1 }).toArray();
    if (dtsHash(src) !== plan.selectedDigest || dtsHash(dst) !== plan.selectedDigest) {
      dtsReject('verification_mismatch', '源数据已变化或目标尚未完整写入，本次未通过对账，请重新比较后续传', 409);
    }
    return dst.length;
  }));
}
