import { randomUUID } from 'node:crypto';
import type { IShellExecutor } from '../types.js';
import type { DesignHandoffCaseResult } from '../shared/design-handoff.js';
import type { DesignCoverCapture, DesignReferenceCapture } from './design-framework-browser.js';
import type { DesignHandoffExecutor } from './design-handoff-browser.js';
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
    const involved = new Set(cases.map(test => test.screenId));
    const { output } = await runDesignBrowserContainer(shell, resolveImage, {
      prototype: prototype.toString('base64'), cases, screens: screens.filter(screen => involved.has(screen.id)),
    }, 75_000);
    if (!output || output.length > 32_000) return undefined;
    const results: unknown = JSON.parse(output);
    return Array.isArray(results) ? results as DesignHandoffCaseResult[] : undefined;
  };
}

export function createDesignReferenceContainer(shell: Shell, resolveImage: Image): DesignReferenceCapture {
  return async function* (prototype, targets) {
    const source = prototype.toString('base64');
    const readBatch = async (references: typeof targets): Promise<{ images?: unknown[]; unavailable?: boolean }> => {
      const { output, unavailable } = await runDesignBrowserContainer(shell, resolveImage,
        { prototype: source, references }, references.length === 1 ? 40_000 : 70_000);
      if (!output || output.length > 8 * 1024 * 1024) return { unavailable };
      try {
        const images: unknown = JSON.parse(output);
        return Array.isArray(images) && images.length === references.length ? { images } : {};
      } catch { return {}; }
    };
    // Keep output within the executor limit. After a batch failure, isolate each remaining screen.
    let batchSize = 4;
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
