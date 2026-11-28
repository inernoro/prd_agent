import { randomUUID } from 'node:crypto';
import type { IShellExecutor } from '../types.js';
import type { DesignHandoffCaseResult } from '../shared/design-handoff.js';
import type { DesignCoverCapture, DesignReferenceCapture } from './design-framework-browser.js';
import type { DesignHandoffExecutor } from './design-handoff-browser.js';
import { fingerprintInstalledDesignBuild, type DesignAcceptanceCapture,
  type InstalledDesignCaptureReply, type InstalledDesignCaptureRequest } from './design-acceptance-browser.js';
import { rejectPlanning } from './engineering-planning-input.js';
import { shellQuoteArg } from './secure-database-cli.js';

type Shell = Pick<IShellExecutor, 'exec'>;
type Image = () => Promise<string | undefined>;

async function runDesignBrowserContainer(shell: Shell, resolveImage: Image, input: object, timeout: number): Promise<{
  output?: string;
  unavailable?: boolean;
}> {
  const name = 'cds-design-cover-' + randomUUID();
  const startedAt = Date.now();
  let stage: 'image' | 'create' | 'run' = 'image';
  const incomplete = (reason: string, exitCode?: number) => {
    // Shell output may include untrusted prototype content. Report the stage and fixed codes only.
    console.warn('[design-browser] request failed', { stage, reason, exitCode, elapsedMs: Date.now() - startedAt });
    return { unavailable: stage !== 'run' || reason === 'capacity' || reason === 'unavailable' };
  };
  let createdId: string | undefined;
  try {
    const image = await resolveImage();
    if (!image) return incomplete('unavailable');
    stage = 'create';
    const command = [
      'docker create --rm --interactive --init --pull=missing',
      '--network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true',
      // PID quotas count Chromium threads, including the raster and font workers.
      '--user=1000:1000 --pids-limit=256 --memory=768m --memory-swap=768m --cpus=1',
      '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=160m,mode=1777 --log-driver=none',
      '--name', name, shellQuoteArg(image),
    ].join(' ');
    const created = await shell.exec(command, { timeout: 120_000 });
    const id = created.stdout.trim();
    if (created.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(id)) return incomplete('container-create', created.exitCode);
    createdId = id;
    stage = 'run';
    const result = await shell.exec('docker start --attach --interactive ' + id, { timeout, stdin: JSON.stringify(input) + '\n' });
    const output = result.stdout.trim();
    return result.exitCode === 0 && output ? { output } : incomplete('container-result', result.exitCode);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return incomplete(code === 'deadline' || code === 'capacity' || code === 'unavailable' ? code : 'execution');
  } finally {
    if (stage !== 'image') {
      await shell.exec('docker rm -f ' + (createdId ?? name), { timeout: 5000,
        ...(createdId ? { executionPurpose: 'temporary-cleanup' } : {}) }).catch(() => {});
    }
  }
}

export function createDesignCoverContainer(shell: Shell, resolveImage: Image): DesignCoverCapture {
  return async (prototype, target) => {
    const { output } = await runDesignBrowserContainer(shell, resolveImage, { prototype: prototype.toString('base64'), target }, 40_000);
    if (!output || output.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return undefined;
    return Buffer.from(output, 'base64');
  };
}

export function createDesignHandoffContainer(shell: Shell, resolveImage: Image): DesignHandoffExecutor {
  return async ({ prototype, screens, cases }) => {
    const source = prototype.toString('base64');
    const results: DesignHandoffCaseResult[] = [];
    // Each sandbox has its own deadline. A slow batch must not exhaust the time for the remaining scenes.
    const batchSize = 6;
    for (let offset = 0; offset < cases.length; offset += batchSize) {
      const batch = cases.slice(offset, offset + batchSize);
      const involved = new Set(batch.map(test => test.screenId));
      const { output, unavailable } = await runDesignBrowserContainer(shell, resolveImage, {
        prototype: source, cases: batch, screens: screens.filter(screen => involved.has(screen.id)),
      }, 75_000);
      if (unavailable) break;
      if (!output || output.length > 32_000) continue;
      try {
        const rows: unknown = JSON.parse(output);
        const ids = new Set(batch.map(test => test.id));
        if (Array.isArray(rows)) results.push(...rows.filter(row => ids.has(row?.caseId)));
      } catch { /* Invalid output leaves this batch unverified without discarding the other batches. */ }
    }
    return results.length ? results : undefined;
  };
}

export function createDesignReferenceContainer(shell: Shell, resolveImage: Image): DesignReferenceCapture {
  return async function* (prototype, targets, retry = false) {
    const source = prototype.toString('base64');
    const readBatch = async (references: typeof targets): Promise<{ images?: unknown[]; unavailable?: boolean }> => {
      const singleTimeout = retry ? 60_000 : 40_000;
      const { output, unavailable } = await runDesignBrowserContainer(shell, resolveImage, { prototype: source, references, retry },
        references.length === 1 ? singleTimeout : 70_000);
      if (!output || output.length > 8 * 1024 * 1024) return { unavailable };
      try {
        const images: unknown = JSON.parse(output);
        return Array.isArray(images) && images.length === references.length ? { images } : {};
      } catch { return {}; }
    };
    // Small partial batches get a fresh browser for each missing screenshot on retry.
    const standardBatchSize = 4;
    let batchSize = retry && targets.length <= standardBatchSize ? 1 : standardBatchSize;
    let consecutiveFailures = 0;
    for (let offset = 0; offset < targets.length;) {
      const references = targets.slice(offset, offset + batchSize);
      const { images, unavailable } = await readBatch(references);
      if (unavailable) return;
      if (!images) {
        if (++consecutiveFailures === 3) return;
        if (references.length === 1) offset++;
        else batchSize = 1;
        continue;
      }
      consecutiveFailures = 0;
      for (const [index, target] of references.entries()) {
        const image: unknown = images[index];
        if (typeof image === 'string' && image.length <= 2 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
          yield { ...target, bytes: Buffer.from(image, 'base64') };
        }
      }
      offset += references.length;
    }
  };
}

const captureFailureStatus = {
  design_capture_build_mismatch: 409, design_capture_commit_changed: 409,
  design_capture_missing_fixture: 422, design_capture_invalid_scene: 422, design_capture_binding_mismatch: 422,
  design_capture_reference_unavailable: 422, design_capture_implementation_unavailable: 422,
  design_capture_incomplete: 422,
} as const;

export function createDesignAcceptanceContainer(shell: Shell, resolveImage: Image, webDist: string): DesignAcceptanceCapture {
  return async ({ prototype, preview, version, ...input }) => {
    if (preview) return rejectPlanning(409, 'design_capture_preview_build_unavailable', '当前隔离浏览器支持对主用 CDS 已部署构建取证。');
    const buildDigest = await fingerprintInstalledDesignBuild(webDist, input.commit).catch(() => undefined);
    if (!buildDigest) return rejectPlanning(409, 'design_capture_commit_changed', '无法核对当前已部署前端产物，请确认正式构建后重试。');
    const request: InstalledDesignCaptureRequest = {
      ...input, kind: 'installed-acceptance', prototype: prototype.toString('base64'), buildDigest,
      version: { createdAt: version.createdAt, delivery: version.delivery && { files: version.delivery.files.map(({ path }) => ({ path })) } },
    };
    const { output } = await runDesignBrowserContainer(shell, resolveImage, request, 45_000);
    const unavailable = () => rejectPlanning(503, 'design_capture_unavailable', '隔离取证浏览器暂不可用，请确认同提交渲染产物并重试。');
    if (!output || output.length > 6 * 1024 * 1024) return unavailable();
    let reply: InstalledDesignCaptureReply;
    try { reply = JSON.parse(output); }
    catch { return unavailable(); }
    if (reply?.ok === false && Object.hasOwn(captureFailureStatus, reply.code)
      && typeof reply.message === 'string' && reply.message.length <= 250) {
      return rejectPlanning(captureFailureStatus[reply.code as keyof typeof captureFailureStatus], reply.code, reply.message);
    }
    if (reply?.ok !== true || !reply.result || !/^[0-9a-f]{64}$/.test(reply.result.fixtureDigest)) return unavailable();
    const { reference, implementation, checks, rules, fixtureDigest } = reply.result;
    const validImage = (image: unknown): image is string => typeof image === 'string' && image.length <= 2 * 1024 * 1024
      && /^[A-Za-z0-9+/]+={0,2}$/.test(image);
    if (!validImage(reference) || !validImage(implementation) || !checks || !rules) return unavailable();
    return { reference: Buffer.from(reference, 'base64'), implementation: Buffer.from(implementation, 'base64'), checks, rules, fixtureDigest };
  };
}
