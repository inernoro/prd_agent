import { posix } from 'node:path';
import type { IShellExecutor } from '../types.js';
import type { OpenDesignPreviewBuild } from './design-acceptance-browser.js';
import { parseCdsPrebuiltManifest } from './cds-prebuilt.js';
import { shellQuoteArg } from './secure-database-cli.js';

const staticFile = /^(?:index\.html|(?:assets\/)?[a-z0-9_-][a-z0-9_.-]*\.(?:js|css|woff2?|png|svg|webp|ico))$/i;
const maximumAssetBytes = 4 * 1024 * 1024;

export function createDesignPreviewBuild(
  resolveContainer: (input: Parameters<OpenDesignPreviewBuild>[0]) => Promise<string | undefined>,
  shell: Pick<IShellExecutor, 'exec' | 'execBackgroundObservation'>,
): OpenDesignPreviewBuild {
  return async input => {
    const container = await resolveContainer(input);
    if (!container || !/^[a-f0-9]{64}$/.test(container)) return undefined;
    const readMember = async (file: string, limit: number) => {
      // Copy a bounded stream from the published container. Never mount its filesystem into the browser.
      const source = shellQuoteArg(container + ':/app/cds/' + file);
      const member = shellQuoteArg(posix.basename(file));
      const pipeline = `docker cp ${source} - | tar -xOf - -- ${member} | head -c ${limit + 1} | base64 -w0`;
      const command = 'bash -o pipefail -c ' + shellQuoteArg(pipeline);
      const options = { timeout: 5000 };
      const result = await (shell.execBackgroundObservation?.(command, options) ?? shell.exec(command, options)).catch(() => undefined);
      if (result?.exitCode !== 0 || !result.stdout || result.stdout.length > Math.ceil((limit + 1) / 3) * 4
        || !/^[a-z0-9+/]+={0,2}$/i.test(result.stdout)) return undefined;
      const data = Buffer.from(result.stdout, 'base64');
      return data.length <= limit ? data : undefined;
    };
    const current = async () => {
      if (await resolveContainer(input) !== container) return false;
      const manifest = await readMember('cds-prebuilt-manifest.json', 8192);
      return Boolean(parseCdsPrebuiltManifest(manifest?.toString('utf8'), input.commit));
    };
    if (!await current()) return undefined;
    return {
      current,
      read: file => staticFile.test(file) ? readMember('web/dist/' + file, maximumAssetBytes) : Promise.resolve(undefined),
    };
  };
}
