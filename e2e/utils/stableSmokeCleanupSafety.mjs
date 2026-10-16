import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const sharedCleanupSafetyPath = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'automations/stable-smoke-48h/safety-fuse.json');
const readOnlyIds = new Set(['CORE-001', 'CORE-002', 'CORE-003', 'CORE-010', 'REG-STSMK-PRODUCTION-READ-ONLY-001', 'REG-AUTH-IDENTITY-PERMISSIONS-001']);
const localPath = directory => resolve(directory, 'cleanup-safety-circuit.json');

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

export function cleanupFailureFromAttachments(attachments, inspectionRunId) {
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
