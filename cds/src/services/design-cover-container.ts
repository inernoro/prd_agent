import { randomUUID } from 'node:crypto';
import type { IShellExecutor } from '../types.js';
import type { DesignCoverCapture } from './design-framework-browser.js';
import { shellQuoteArg } from './secure-database-cli.js';

export function createDesignCoverContainer(shell: Pick<IShellExecutor, 'exec'>,
  resolveImage: () => Promise<string | undefined>): DesignCoverCapture {
  return async (prototype, target) => {
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
      const result = await shell.exec('docker start --attach --interactive ' + id, { timeout: 30_000,
        stdin: JSON.stringify({ prototype: prototype.toString('base64'), target }) + '\n' });
      const output = result.stdout.trim();
      if (result.exitCode !== 0 || !output || output.length > 6 * 1024 * 1024
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return undefined;
      return Buffer.from(output, 'base64');
    } finally {
      // The name is unique to this invocation, including when create or attach times out.
      await shell.exec('docker rm -f ' + (createdId ?? name), { timeout: 5000,
        ...(createdId ? { executionPurpose: 'temporary-cleanup' } : {}) }).catch(() => {});
    }
  };
}
