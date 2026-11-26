import { randomUUID } from 'node:crypto';
import type { IShellExecutor } from '../types.js';
import type { DesignHandoffCaseResult } from '../shared/design-handoff.js';
import type { DesignCoverCapture, DesignReferenceCapture } from './design-framework-browser.js';
import type { DesignHandoffExecutor } from './design-handoff-browser.js';
import { shellQuoteArg } from './secure-database-cli.js';

type Shell = Pick<IShellExecutor, 'exec'>;
type Image = () => Promise<string | undefined>;

async function runDesignBrowserContainer(shell: Shell, resolveImage: Image, input: object, timeout: number) {
  const image = await resolveImage();
  if (!image) return undefined;
  const name = 'cds-design-cover-' + randomUUID();
  const command = [
    'docker create --rm --interactive --init --pull=missing',
    '--network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true',
    '--user=1000:1000 --pids-limit=128 --memory=512m --memory-swap=512m --cpus=1',
    '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=160m,mode=1777 --log-driver=none',
    '--name', name, shellQuoteArg(image),
  ].join(' ');
  let createdId: string | undefined;
  try {
    const created = await shell.exec(command, { timeout: 120_000 });
    const id = created.stdout.trim();
    if (created.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(id)) return undefined;
    createdId = id;
    const result = await shell.exec('docker start --attach --interactive ' + id, { timeout, stdin: JSON.stringify(input) + '\n' });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } finally {
    await shell.exec('docker rm -f ' + (createdId ?? name), { timeout: 5000,
      ...(createdId ? { executionPurpose: 'temporary-cleanup' } : {}) }).catch(() => {});
  }
}

export function createDesignCoverContainer(shell: Shell, resolveImage: Image): DesignCoverCapture {
  return async (prototype, target) => {
    const output = await runDesignBrowserContainer(shell, resolveImage, { prototype: prototype.toString('base64'), target }, 30_000);
    if (!output || output.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return undefined;
    return Buffer.from(output, 'base64');
  };
}

export function createDesignHandoffContainer(shell: Shell, resolveImage: Image): DesignHandoffExecutor {
  return async ({ prototype, screens, cases }) => {
    const involved = new Set(cases.map(test => test.screenId));
    const output = await runDesignBrowserContainer(shell, resolveImage, {
      prototype: prototype.toString('base64'), cases, screens: screens.filter(screen => involved.has(screen.id)),
    }, 75_000);
    if (!output || output.length > 32_000) return undefined;
    const results: unknown = JSON.parse(output);
    return Array.isArray(results) ? results as DesignHandoffCaseResult[] : undefined;
  };
}

export function createDesignReferenceContainer(shell: Shell, resolveImage: Image): DesignReferenceCapture {
  return async function* (prototype, targets) {
    // Keep batches below the isolated executor's output limit, and publish progress between batches.
    const source = prototype.toString('base64');
    for (let offset = 0; offset < targets.length; offset += 4) {
      const references = targets.slice(offset, offset + 4);
      const output = await runDesignBrowserContainer(shell, resolveImage, { prototype: source, references }, 70_000);
      if (!output || output.length > 8 * 1024 * 1024) return;
      const images: unknown = JSON.parse(output);
      if (!Array.isArray(images) || images.length !== references.length) return;
      for (const [index, target] of references.entries()) {
        const image: unknown = images[index];
        if (typeof image === 'string' && image.length <= 2 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
          yield { ...target, bytes: Buffer.from(image, 'base64') };
        }
      }
    }
  };
}
