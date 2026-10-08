import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const defaultHarnessUrl = new URL(
  '../../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs',
  import.meta.url,
).href;
const allowedStatuses = new Set(['通过', '不通过', '部分通过', '未执行', '需干预']);
const childRouteEntries = new Set(['/visual-agent', '/literary-agent', '/video-agent', '/document-store']);

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`缺少 ${label}，不能写入稳定冒烟视觉证据。`);
  return normalized;
}

function normalizeOrigin(value, label) {
  try {
    return new URL(required(value, label)).origin;
  } catch {
    throw new Error(`${label} 不是有效地址：${value}`);
  }
}

function currentPageLocation(page) {
  const raw = required(page?.url?.(), '当前页面地址');
  try {
    const parsed = new URL(raw);
    return { origin: parsed.origin, pathname: parsed.pathname || '/' };
  } catch {
    throw new Error(`当前页面地址无效：${raw}`);
  }
}

function pageMatchesEntry(actualPath, entryPath) {
  if (actualPath === entryPath) return true;
  return childRouteEntries.has(entryPath) && actualPath.startsWith(`${entryPath}/`);
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`无法读取${label} ${path}：${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label}不是合法 JSON：${error.message}`);
  }
}

async function readManifest(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('根节点必须是数组');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`视觉证据 manifest 无法读取：${error.message}`);
  }
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function withFileLock(lockPath, action, options = {}) {
  const timeoutMs = options.timeoutMs || 30_000;
  const staleAfterMs = options.staleAfterMs || 5 * 60_000;
  const startedAt = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const current = await stat(lockPath);
        if (Date.now() - current.mtimeMs > staleAfterMs) {
          await unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`等待视觉证据锁超时：${lockPath}`);
      }
      await sleep(25);
    }
  }
  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

function validatePlan(plan, runtime) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.slots)) {
    throw new Error('视觉取证计划缺少 slots 数组。');
  }
  if (plan.runId !== runtime.runId) {
    throw new Error(`视觉计划 runId 不一致：计划 ${plan.runId || '缺失'}，运行 ${runtime.runId}`);
  }
  if (plan.commit !== runtime.commit) {
    throw new Error(`视觉计划 commit 不一致：计划 ${plan.commit || '缺失'}，运行 ${runtime.commit}`);
  }
}

function findSlot(plan, slotId, environment) {
  const matching = plan.slots.filter((slot) => slot?.slotId === slotId);
  if (matching.length !== 1) {
    throw new Error(`视觉计划中的 slotId ${slotId} 数量应为 1，实际为 ${matching.length}`);
  }
  const slot = matching[0];
  if (slot.environment !== environment) {
    throw new Error(`视觉位 ${slotId} 环境不一致：计划 ${slot.environment}，运行 ${environment}`);
  }
  required(slot.primaryState, `${slotId}.primaryState`);
  required(slot.module, `${slotId}.module`);
  required(slot.entryPath, `${slotId}.entryPath`);
  required(slot.pageOrigin, `${slotId}.pageOrigin`);
  required(slot.theme, `${slotId}.theme`);
  required(slot.viewportClass, `${slotId}.viewportClass`);
  required(slot.methodAnchor, `${slotId}.methodAnchor`);
  required(slot.breadcrumb, `${slotId}.breadcrumb`);
  if (!Array.isArray(slot.coverageStates) || slot.coverageStates.length === 0) {
    throw new Error(`视觉位 ${slotId} 缺少 coverageStates。`);
  }
  return slot;
}

function figureName(plan, slotId) {
  const index = plan.slots.findIndex((slot) => slot?.slotId === slotId);
  if (index < 0) throw new Error(`视觉计划中不存在 slotId ${slotId}`);
  return `${String(index + 1).padStart(3, '0')}-${slotId.toLowerCase()}`;
}

function validatePageForSlot(page, slot) {
  const actual = currentPageLocation(page);
  const plannedOrigin = normalizeOrigin(slot.pageOrigin, `${slot.slotId}.pageOrigin`);
  if (actual.origin !== plannedOrigin) {
    throw new Error(`视觉位 ${slot.slotId} 页面来源不一致：计划 ${plannedOrigin}，实际 ${actual.origin}`);
  }
  if (!pageMatchesEntry(actual.pathname, slot.entryPath)) {
    throw new Error(`视觉位 ${slot.slotId} 页面路径不一致：计划 ${slot.entryPath}，实际 ${actual.pathname}`);
  }
  return actual;
}

function validateRecord(record, plan, slot, runtime, actual) {
  const expected = {
    slotId: slot.slotId,
    runId: runtime.runId,
    commit: runtime.commit,
    environment: runtime.environment,
    module: slot.module,
    primaryState: slot.primaryState,
    theme: slot.theme,
    viewportClass: slot.viewportClass,
    methodAnchor: slot.methodAnchor,
    breadcrumb: slot.breadcrumb,
    pageOrigin: actual.origin,
    pagePath: actual.pathname,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (record?.[field] !== value) {
      throw new Error(`视觉位 ${slot.slotId} 的 ${field} 不一致：计划 ${value}，证据 ${record?.[field]}`);
    }
  }
  if (JSON.stringify(record.coverageStates) !== JSON.stringify(slot.coverageStates)) {
    throw new Error(`视觉位 ${slot.slotId} 的 coverageStates 与计划不一致。`);
  }
  const capturedAt = Date.parse(record.capturedAt || '');
  const planStartedAt = Date.parse(plan.captureStartedAt || '');
  if (!Number.isFinite(capturedAt) || (Number.isFinite(planStartedAt) && capturedAt < planStartedAt)) {
    throw new Error(`视觉位 ${slot.slotId} 的 capturedAt 早于本轮取证开始时间或无效。`);
  }
}

function runtimeFromEnvironment(environment) {
  return {
    planPath: String(environment.STABLE_SMOKE_VISUAL_PLAN || '').trim(),
    outputPath: String(environment.STABLE_SMOKE_VISUAL_OUTPUT || '').trim(),
    runId: String(environment.STABLE_SMOKE_RUN_ID || '').trim(),
    commit: String(environment.STABLE_SMOKE_COMMIT || '').trim(),
    environment: String(environment.STABLE_SMOKE_ENVIRONMENT || '').trim(),
  };
}

export function createStableSmokeVisualEvidence(options = {}) {
  const environment = options.environment || process.env;
  const harnessLoader = options.harnessLoader || (() => import(defaultHarnessUrl));

  return async function captureStableSmokeVisualEvidence(page, testInfo, input = {}) {
    const runtime = runtimeFromEnvironment(environment);
    if (!runtime.planPath && !runtime.outputPath) {
      return { captured: false, reason: 'visual-evidence-disabled' };
    }
    if (!runtime.planPath || !runtime.outputPath) {
      throw new Error('STABLE_SMOKE_VISUAL_PLAN 与 STABLE_SMOKE_VISUAL_OUTPUT 必须同时配置。');
    }
    required(runtime.runId, 'STABLE_SMOKE_RUN_ID');
    required(runtime.commit, 'STABLE_SMOKE_COMMIT');
    required(runtime.environment, 'STABLE_SMOKE_ENVIRONMENT');
    const slotId = required(input.slotId, 'slotId');
    const status = input.status || '通过';
    if (!allowedStatuses.has(status)) throw new Error(`视觉位 ${slotId} 使用了未知状态：${status}`);
    if (input.failureEvidence && (!input.failureReason || status === '通过')) {
      throw new Error(`视觉位 ${slotId} 的失败证据必须提供 failureReason 且状态不能为通过。`);
    }
    if (!input.target && !input.overviewJustification) {
      throw new Error(`视觉位 ${slotId} 必须提供可见目标，或说明整体截图的验收理由。`);
    }
    if (input.overviewJustification && String(input.overviewJustification).trim().length < 8) {
      throw new Error(`视觉位 ${slotId} 的整体截图理由过短，无法说明它证明什么。`);
    }

    const planPath = resolve(runtime.planPath);
    const outputPath = resolve(runtime.outputPath);
    await mkdir(outputPath, { recursive: true });
    const plan = await readJson(planPath, '视觉取证计划');
    validatePlan(plan, runtime);
    const slot = findSlot(plan, slotId, runtime.environment);
    const actual = validatePageForSlot(page, slot);
    const manifestPath = join(outputPath, 'manifest.json');
    const manifestLock = join(outputPath, '.manifest.lock');
    const slotLock = join(outputPath, `.${slotId}.lock`);

    return withFileLock(slotLock, async () => {
      const existingRecord = await withFileLock(manifestLock, async () => {
        const existing = await readManifest(manifestPath);
        return existing.find((record) => record?.slotId === slotId);
      });
      if (existingRecord) {
        const recordedActual = {
          origin: normalizeOrigin(existingRecord.pageOrigin, `${slotId}.existing.pageOrigin`),
          pathname: required(existingRecord.pagePath, `${slotId}.existing.pagePath`),
        };
        if (!pageMatchesEntry(recordedActual.pathname, slot.entryPath)) {
          throw new Error(`视觉位 ${slotId} 的既有证据路径不属于计划入口：${recordedActual.pathname}`);
        }
        validateRecord(existingRecord, plan, slot, runtime, recordedActual);
        await access(existingRecord.path).catch((error) => {
          throw new Error(`视觉位 ${slotId} 已有 manifest 记录，但证据文件不可读：${error.message}`);
        });
        if (status === '通过'
          && (existingRecord.manualStatus !== '通过' || existingRecord.automatedStatus !== '通过')) {
          throw new Error(`视觉位 ${slotId} 的既有证据未通过，不能在重试时按通过复用。`);
        }
        if (testInfo?.attach) {
          await testInfo.attach(slotId, { path: existingRecord.path, contentType: 'image/png' });
        }
        return {
          captured: false,
          reason: 'slot-already-captured',
          record: existingRecord,
          manifestPath,
        };
      }

      if (input.target) {
        await input.target.waitFor({ state: 'visible', timeout: input.timeout || 15_000 });
        if (await input.target.count() !== 1) {
          throw new Error(`视觉位 ${slotId} 的可见目标必须唯一。`);
        }
      }
      if (input.themeTarget) {
        await input.themeTarget.waitFor({ state: 'visible', timeout: input.timeout || 15_000 });
        if (await input.themeTarget.count() !== 1) {
          throw new Error(`视觉位 ${slotId} 的主题测量区域必须唯一。`);
        }
      }

      const harness = await harnessLoader();
      if (input.target) await harness.box(page, input.target, '1');
      let record;
      try {
        const captionSuffix = String(input.caption || input.overviewJustification || '').trim();
        const caption = captionSuffix
          ? `${slot.expectedProof}；${captionSuffix}`
          : slot.expectedProof;
        record = await harness.shot(page, outputPath, figureName(plan, slotId), caption, {
          expectText: input.expectText,
          skipReady: Boolean(input.skipReady),
          overview: Boolean(input.overviewJustification),
          module: slot.module,
          slotId: slot.slotId,
          evidenceState: slot.primaryState,
          primaryState: slot.primaryState,
          coverageStates: slot.coverageStates,
          testType: slot.testType,
          status,
          manualStatus: status,
          theme: slot.theme,
          themeTarget: input.themeTarget,
          methodAnchor: slot.methodAnchor,
          breadcrumb: slot.breadcrumb,
          environment: slot.environment,
          runId: runtime.runId,
          commit: runtime.commit,
          failureEvidence: Boolean(input.failureEvidence),
          failureReason: input.failureReason,
          allowBlockingOverlay: Boolean(input.allowBlockingOverlay),
        });
        validateRecord(record, plan, slot, runtime, actual);
        if (testInfo?.attach) {
          await testInfo.attach(slotId, { path: record.path, contentType: 'image/png' });
        }
      } finally {
        if (input.target) await harness.clearBoxes(page).catch(() => undefined);
      }

      await withFileLock(manifestLock, async () => {
        const existing = await readManifest(manifestPath);
        if (existing.some((candidate) => candidate?.slotId === slotId)) {
          throw new Error(`视觉位 ${slotId} 在并发取证期间被其他 worker 写入，禁止覆盖。`);
        }
        await atomicWriteJson(manifestPath, [...existing, record]);
      });

      if (status === '通过' && record.automatedStatus !== '通过') {
        throw new Error(`视觉位 ${slotId} 自动检查未通过，不能按通过核销。`);
      }
      return { captured: true, record, manifestPath };
    });
  };
}

const defaultCapture = createStableSmokeVisualEvidence();

export async function captureStableSmokeVisualEvidence(page, testInfo, input) {
  return defaultCapture(page, testInfo, input);
}

export const _stableSmokeVisualEvidenceInternals = {
  figureName,
  pageMatchesEntry,
  validatePlan,
  validateRecord,
};
