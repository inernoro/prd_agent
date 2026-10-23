import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const sharedCleanupSafetyPath = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'automations/stable-smoke-48h/safety-fuse.json');
const readOnlyIds = new Set(['CORE-001', 'CORE-002', 'CORE-003', 'CORE-010', 'REG-STSMK-PRODUCTION-READ-ONLY-001', 'REG-AUTH-IDENTITY-PERMISSIONS-001']);
const localPath = directory => resolve(directory, 'cleanup-safety-circuit.json');

// Preserve offsets while excluding comments and string contents from executable-order checks.
function csharpView(source, maskStrings = true) {
  return source.replace(/\/\/[^\r\n]*|\/\*[^]*?\*\/|@"(?:""|[^"])*"|"(?:\\[^]|[^"\\])*"|'(?:\\[^]|[^'\\])*'/g,
    token => maskStrings || token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token);
}
function csharpBlock(source, code, signature) {
  const matches = [...source.matchAll(signature)];
  if (matches.length !== 1) throw Error('unknown declaration');
  const start = matches[0].index;
  const open = start + matches[0][0].length;
  if (code[open] !== '{') throw Error('unknown body');
  let depth = 1, end = open + 1;
  while (end < code.length && depth) {
    if (code[end] === '{') depth++;
    if (code[end] === '}') depth--;
    end++;
  }
  if (depth) throw Error('unknown body end');
  return { start, end, body: code.slice(open + 1, end - 1), rawBody: source.slice(open + 1, end - 1) };
}

/** Negative requests are safe only when the actual deployed handler rejects before any write. */
export async function readImageReferenceRejectionCapability({ getVersion, readSource = (revision, path) => execFileSync('git', ['show', `${revision}:${path}`], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8', timeout: 10000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }) {
  let deploymentCommit;
  const blocked = reason => ({ supported: false, ...(deploymentCommit ? { deploymentCommit } : {}), reason: `${reason}；本负例零创建停跑，保留原case未执行及400断言。不要求发布工具分支或指定业务版本，须能证明当前部署在计费前拒绝才可按原case复验。` });
  const version = async () => {
    const response = await getVersion();
    if (!response.ok()) throw Error('version unavailable');
    const value = await response.json();
    if (!/^[a-f0-9]{40}$/.test(value.actualCommit || '') || value.expectedCommit !== value.actualCommit || value.commitMatch !== 'match') throw Error('version drift');
    return value.actualCommit;
  };
  try {
    const revision = await version();
    deploymentCommit = revision;
    const controller = readSource(revision, 'prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs');
    const validator = readSource(revision, 'prd-api/src/PrdAgent.Core/Models/MultiImage/ImageReferenceContract.cs');
    const clean = csharpView(controller, false), code = csharpView(controller);
    const validatorClean = csharpView(validator, false), validatorCode = csharpView(validator);
    // Unknown conditional-compilation shapes cannot serve as a safety proof.
    if (code.includes('#') || validatorCode.includes('#')) return blocked('实际源码含无法判定的条件编译');
    const handler = csharpBlock(clean, code, /\[HttpPost\("workspaces\/\{id\}\/image-gen\/runs"\)\]\s*(?:\[[^\n]+\]\s*)*public\s+async\s+Task<IActionResult>\s+CreateWorkspaceImageGenRun\s*\([^)]*\)\s*/g);
    const dto = csharpBlock(clean, code, /public\s+class\s+CreateWorkspaceImageGenRunRequest\s*/g);
    if (!/public\s+int\?\s+ExpectedImageRefCount\s*\{\s*get;\s*set;\s*\}(?!\s*=)/.test(dto.body)) return blocked('实际请求声明缺少无默认值的可空参考数量字段');
    const guard = csharpBlock(handler.body, handler.body, /var\s+referenceValidation\s*=\s*ImageReferenceContract\.ValidateDeclared\(\s*request\?\.ExpectedImageRefCount,\s*submittedImageRefCount,\s*!string\.IsNullOrWhiteSpace\(request\?\.MaskBase64\)\s*\);\s*if\s*\(!referenceValidation\.IsValid\)\s*/g);
    const before = handler.body.slice(0, guard.start);
    if (!before.replace(/\s+/g, '').includes('varsubmittedImageRefCount=request?.ImageRefs?.Count>0?request.ImageRefs.Count:string.IsNullOrWhiteSpace(initSha)?0:1;')) return blocked('实际handler不能证明收到的参考数量计算');
    const depth = [...before].reduce((sum, char) => sum + (char === '{' ? 1 : char === '}' ? -1 : 0), 0);
    const rejection = guard.body.replace(/\s+/g, '');
    if (depth !== 1 || /\b(?:catch|goto)\b/.test(before)
      || (rejection.match(/\breturn/g) || []).length !== 1
      || !rejection.endsWith('returnBadRequest(ApiResponse<object>.Fail(referenceValidation.ErrorCode??ImageReferenceContract.IncompleteCode,message));')) return blocked('实际handler未能证明直接拒绝无效数量');
    const writes = [...handler.body.matchAll(/\b(?:Insert\w*|Update\w*|Delete\w*|Replace\w*|Upsert\w*|Enqueue\w*|Publish\w*|Generate\w*)\s*\(/g)];
    if (!writes.some(item => item[0].startsWith('InsertOneAsync')) || !writes.some(item => item[0].startsWith('UpsertWorkspaceCanvasPlaceholderAsync'))
      || writes.some(item => item.index < guard.end)) return blocked('实际拒绝未被证明先于任务插入、画布写入及排队');
    const validatorClass = csharpBlock(validatorClean, validatorCode, /public\s+static\s+class\s+ImageReferenceContract\s*/g);
    const compact = validatorClass.body.replace(/\s+/g, '');
    const declared = 'publicstaticImageReferenceValidationValidateDeclared(int?expectedCount,intsubmittedCount,boolhasMask=false)=>expectedCountisnull?newImageReferenceValidation(false,RequiredCountCode,0,submittedCount):Validate(expectedCount,submittedCount,hasMask);';
    const validate = csharpBlock(validatorClass.rawBody, validatorClass.body, /public\s+static\s+ImageReferenceValidation\s+Validate\(int\?\s+expectedCount,\s*int\s+submittedCount,\s*bool\s+hasMask\s*=\s*false\)\s*/g);
    const expectedBody = 'if(expectedCountis<0||submittedCount<0){returnnewImageReferenceValidation(false,InvalidCountCode,expectedCount??0,submittedCount);}vareffectiveExpected=expectedCount??submittedCount;if(hasMask&&effectiveExpected==0)effectiveExpected=1;returneffectiveExpected==submittedCount?newImageReferenceValidation(true,null,effectiveExpected,submittedCount):newImageReferenceValidation(false,IncompleteCode,effectiveExpected,submittedCount);';
    if (!compact.includes(declared) || validate.body.replace(/\s+/g, '') !== expectedBody
      || !validatorCode.replace(/\s+/g, '').includes('publicreadonlyrecordstructImageReferenceValidation(boolIsValid,string?ErrorCode,intExpectedCount,intSubmittedCount);')
      || !/public\s+const\s+string\s+RequiredCountCode\s*=\s*"IMAGE_REF_COUNT_REQUIRED";/.test(validatorClass.rawBody)
      || !/public\s+const\s+string\s+IncompleteCode\s*=\s*"IMAGE_REF_INCOMPLETE";/.test(validatorClass.rawBody)) return blocked('实际validator缺少可核验的缺失、数量不一致与错误码合同');
    if (await version() !== revision) return blocked('核验期间实际部署版本漂移');
    return { supported: true, reason: '当前实际源码具备创建前拒绝声明及顺序；仅为负例安全前置，仍须原400业务断言，不是业务通过', deploymentCommit: revision,
      controllerSha256: createHash('sha256').update(controller).digest('hex'), validatorSha256: createHash('sha256').update(validator).digest('hex') };
  } catch {
    return blocked('实际版本漂移或源码合同不可可靠核验');
  }
}

export async function readShortVideoCleanupCapability({ getVersion, readControllerSource = revision => execFileSync('git', ['show', `${revision}:prd-api/src/PrdAgent.Api/Controllers/Api/ShortVideoMaterialController.cs`], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }) {
  const blocked = reason => ({ supported: false, reason: `${reason}；本用例零创建停跑，保留未执行。恢复当前部署可核验的单任务清理能力后按原case复验，不要求发布工具分支或指定业务版本。` });
  try {
    const response = await getVersion();
    if (!response.ok()) return blocked('当前实际部署版本无法核实');
    const version = await response.json();
    const revision = version.actualCommit;
    if (!/^[a-f0-9]{40}$/.test(revision || '') || version.expectedCommit !== revision || version.commitMatch !== 'match') return blocked('当前部署版本不完整或发生漂移，不能猜测清理能力');
    const source = readControllerSource(revision);
    const contracts = [/^\s*\[Route\("api\/short-video-materials"\)\]/m, /^\s*\[HttpGet\("runs\/\{runId\}"\)\]/m, /^\s*\[HttpDelete\("runs\/\{runId\}"\)\]/m, /^\s*\[HttpPost\("runs\/\{runId\}\/cancel"\)\]/m];
    return { ...(!contracts.every(pattern => pattern.test(source)) ? blocked('当前实际部署未声明完整的单任务取消、删除和回读路由') : { supported: true, reason: '当前实际部署具备路由声明；只证明创建前安全前置，实际清理仍须原资源404' }), deploymentCommit: revision, controllerSha256: createHash('sha256').update(source).digest('hex') };
  } catch {
    return blocked('当前实际部署源码或版本不可核验，清理能力未知');
  }
}

function readCircuit(path, environment) {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.schemaVersion !== 1 || !['cds', 'production'].includes(value.environment) || !Array.isArray(value.resourceIds)) throw Error('invalid circuit');
    if (value.environment !== environment) return undefined;
    if (value.active === false && value.recovery?.status === 'verified'
      && value.resourceIds.length > 0
      && value.resourceIds.every(id => value.recovery.readbacks?.some(item => item.resourceId === id && item.status === 404))) return undefined;
    return { reason: value.reason || '清理风险尚未以原资源404核销，禁止新业务写入', resourceIds: value.resourceIds };
  } catch {
    return { reason: '清理安全状态无法读取或格式不完整，禁止新业务写入；须恢复原清理证据', resourceIds: [] };
  }
}

export function readCleanupBlocker({ outputDirectory, environment, sharedPath = sharedCleanupSafetyPath }) {
  return readCircuit(localPath(outputDirectory), environment) || readCircuit(sharedPath, environment);
}

export function isCleanupReadOnlyJourney(title) {
  const ids = [...String(title).matchAll(/\[((?:CORE|REG)-[^\]]+)\]/gi)].map(match => match[1].toUpperCase());
  const allTags = [...String(title).matchAll(/\[((?:COMMON|CORE|REC|FILE|PARSE|VIDEO|LIT|VIS|MVIS|GW|WEB|REG)-[^\]]+)\]/gi)];
  return ids.length > 0 && ids.length === allTags.length && ids.every(id => readOnlyIds.has(id));
}

function attachmentJson(item) {
  const raw = Buffer.isBuffer(item.body) ? item.body.toString('utf8') : String(item.body || '');
  return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
}

// 只消费已登记的创建响应，不从日志自由文本或任意runId猜资源归属。
export function knownCreatedResources(attachments, inspectionRunId) {
  const resources = new Map();
  const simple = {
    'video-idle-project-created': [['projectId', '/api/video-agent/projects/']],
    'video-idle-run-created': [['projectId', '/api/video-agent/projects/'], ['runId', '/api/video-agent/runs/']],
    'empty-file-store-created': [['storeId', '/api/document-store/stores/']],
    'empty-file-entry-created': [['storeId', '/api/document-store/stores/'], ['entryId', '/api/document-store/entries/']],
    'short-video-invalid-store-created': [['storeId', '/api/document-store/stores/']],
    'short-video-invalid-seed-created': [['storeId', '/api/document-store/stores/'], ['seedEntryId', '/api/document-store/entries/']],
    'recording-store-created': [['storeId', '/api/document-store/stores/']],
    'visual-workspace-created': [['workspaceId', '/api/visual-agent/image-master/workspaces/', '/detail']],
    'literary-workspace-created': [['workspaceId', '/api/literary-agent/workspaces/', '/detail']],
    'literary-image-run-created': [['runId', '/api/literary-agent/image-gen/runs/']],
    'literary-image-asset-created': [['assetId', '/api/visual-agent/image-master/assets/']],
    'recording-idempotency-store-created': [['storeId', '/api/document-store/stores/']],
    'recording-idempotency-session-created': [['storeId', '/api/document-store/stores/'], ['sessionId', '/api/document-store/recording-uploads/']],
    'recording-idempotency-entry-created': [['storeId', '/api/document-store/stores/'], ['sessionId', '/api/document-store/recording-uploads/'], ['entryId', '/api/document-store/entries/'], ['deferredTranscriptionRunId', '/api/document-store/agent-runs/', '', true]],
    'recording-idempotency-second-complete': [['storeId', '/api/document-store/stores/'], ['sessionId', '/api/document-store/recording-uploads/'], ['entryId', '/api/document-store/entries/'], ['deferredTranscriptionRunId', '/api/document-store/agent-runs/', '', true]],
    'default-white-peach-actual-request': [['runId', '/api/visual-agent/image-gen/runs/']],
    'jpeg-actual-ui-request': [['runId', '/api/visual-agent/image-gen/runs/']],
    'vis004-run-created': [['runId', '/api/visual-agent/image-gen/runs/']],
    'mobile-visual-run-created': [['runId', '/api/visual-agent/image-gen/runs/']],
    'multi-image-run-created': [['runId', '/api/visual-agent/image-gen/runs/']],
  };
  for (const item of attachments || []) {
    const fields = Object.hasOwn(simple, item.name) ? simple[item.name] : undefined;
    if (!fields) continue;
    const body = attachmentJson(item);
    if (body.inspectionRunId && body.inspectionRunId !== inspectionRunId) throw Error('创建回执归属不符');
    for (const [field, prefix, suffix = '', optional = false] of fields) {
      const id = body[field];
      if (optional && !id) continue;
      const recordingEntry = field === 'entryId' && id === `recording-completed-${body.sessionId}`;
      const recordingRun = field === 'deferredTranscriptionRunId' && id === `recording-archive-transcribe-${body.sessionId}`;
      if (!/^[a-f0-9]{32}$/.test(id || '') && !((recordingEntry || recordingRun) && /^[a-f0-9]{32}$/.test(body.sessionId || ''))) throw Error('创建回执资源标识无效');
      resources.set(prefix + id + suffix, { id, path: prefix + id + suffix });
    }
  }
  return [...resources.values()];
}

export function cleanupFailureFromAttachments(attachments, inspectionRunId, scope = {}) {
  let known;
  try { known = knownCreatedResources(attachments, inspectionRunId); } catch {
    return { resourceIds: [], reason: '创建回执无法可靠核验；清理未知，停止后续新业务写入' };
  }
  const canonical = (attachments || []).filter(item => item.name === 'stable-smoke-cleanup-receipt');
  if (known.length && canonical.length !== 1) return { resourceIds: known.map(row => row.id), reason: '已创建资源缺少唯一独立清理回执；停止自动重试及后续新业务写入' };
  for (const item of canonical) {
    try {
      const body = attachmentJson(item);
      if (!validCleanupReceipt(body, { ...scope, inspectionRunId, knownResources: known })) return { resourceIds: [...new Set([...known.map(row => row.id), ...(body.resources || []).map(row => row.id).filter(id => /^[a-f0-9]{32}$/.test(id))])], reason: '本轮独立清理回执漏核已知资源、未全部404或归属不符；停止后续新业务写入，先恢复原资源清理' };
    } catch {
      return { resourceIds: [], reason: '本轮独立清理回执无法读取；清理未知，停止后续新业务写入' };
    }
  }
  const items = (attachments || []).filter(item => item.name === 'short-video-cleanup-receipt');
  for (const item of items) {
    try {
      const body = JSON.parse(Buffer.isBuffer(item.body) ? item.body.toString('utf8') : String(item.body));
      if (body.inspectionRunId !== inspectionRunId) throw Error('receipt scope mismatch');
      const resourceIds = [body.runId, body.storeId, body.uploadedEntryId].filter(Boolean);
      if (!resourceIds.length || resourceIds.some(id => !/^[a-f0-9]{32}$/.test(id))) throw Error('receipt identity invalid');
      const incomplete = (Array.isArray(body.errors) && body.errors.length > 0)
        || (body.runId && body.runReadbackStatus !== 404)
        || (body.storeId && body.storeReadbackStatus !== 404)
        || (body.uploadedEntryId && body.entryReadbackStatus !== 404);
      if (incomplete) return { resourceIds, reason: '本轮短视频清理回执未全部404；停止自动重试及后续新业务写入，先恢复原资源清理' };
    } catch {
      return { resourceIds: [], reason: '本轮短视频清理回执缺失或身份不符，清理结果未知；停止自动重试及后续新业务写入' };
    }
  }
  return undefined;
}

// 只有原attempt自己保存的逐资源404可消除该attempt的清理未知；不改变业务红项。
export function validCleanupReceipt(body, { inspectionRunId, environment, testId, retry, knownResources = [] } = {}) {
  return body?.schemaVersion === 1
    && typeof inspectionRunId === 'string' && inspectionRunId.startsWith('stsmk-')
    && body.inspectionRunId === inspectionRunId
    && (!environment || body.environment === environment)
    && (!testId || body.testId === testId)
    && (retry === undefined || body.retry === retry)
    && Array.isArray(body.errors) && body.errors.length === 0
    && Array.isArray(body.resources) && body.resources.length > 0
    && body.resources.every(row => typeof row.kind === 'string' && row.readbackStatus === 404 && (
      /^[a-f0-9]{32}$/.test(row.id)
      || (row.kind === 'entry' && /^recording-completed-[a-f0-9]{32}$/.test(row.id) && row.path === `/api/document-store/entries/${row.id}`)
      || (row.kind === `run:${row.id}` && /^recording-archive-transcribe-[a-f0-9]{32}$/.test(row.id) && row.path === `/api/document-store/agent-runs/${row.id}`)
    ))
    && new Set(body.resources.map(row => `${row.kind}:${row.id}`)).size === body.resources.length
    && knownResources.every(known => body.resources.some(row => row.id === known.id && row.path === known.path));
}

export async function cleanupAndReadBackResources({ resources, remove, read, attach, inspectionRunId, environment, testId, retry }) {
  const receipt = { schemaVersion: 1, inspectionRunId, environment, testId, retry,
    resources: resources.map(row => ({ ...row, readbackStatus: null })), errors: [] };
  // 删除出错也继续全部精确回读，先保存回执，再抛清理异常。
  try { await remove(); } catch { receipt.errors.push('资源删除请求未完成'); }
  for (const row of receipt.resources) {
    try { row.readbackStatus = await read(row); } catch { receipt.errors.push(`${row.kind}回读失败`); }
    if (row.readbackStatus !== 404) receipt.errors.push(`${row.kind}未回读404`);
  }
  await attach(receipt);
  if (!validCleanupReceipt(receipt, { inspectionRunId, environment, testId, retry })) throw Error('本轮独立清理回读未闭环');
  return receipt;
}

function writeCircuit(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.next`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}

export function writeCleanupBlocker(outputDirectory, { environment, inspectionRunId, resourceIds, reason, sharedPath = sharedCleanupSafetyPath }) {
  const circuit = { schemaVersion: 1, active: true, environment, sourceRunId: inspectionRunId, resourceIds, reason, createdAt: new Date().toISOString() };
  // 先保住当轮；共享状态损坏或属于另一环境时不得覆盖已有风险。
  writeCircuit(localPath(outputDirectory), circuit);
  if (existsSync(sharedPath)) {
    const previous = JSON.parse(readFileSync(sharedPath, 'utf8'));
    if (previous.schemaVersion !== 1 || !['cds', 'production'].includes(previous.environment) || !Array.isArray(previous.resourceIds)) throw Error('共享清理状态无效，原文件保持不变');
    if (readCircuit(sharedPath, previous.environment)) {
      if (previous.environment !== environment) throw Error('另一环境的清理风险尚未核销，原共享状态保持不变');
      circuit.resourceIds = [...new Set([...previous.resourceIds, ...resourceIds])];
      circuit.sourceRunIds = [...new Set([...(previous.sourceRunIds || [previous.sourceRunId]), inspectionRunId])].filter(Boolean);
      circuit.reason = [...new Set([previous.reason, reason])].filter(Boolean).join('；');
    }
  }
  writeCircuit(sharedPath, circuit);
}
