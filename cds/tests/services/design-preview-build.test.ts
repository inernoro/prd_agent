import { describe, expect, it, vi } from 'vitest';
import { createDesignPreviewBuild } from '../../src/services/design-preview-build.js';

const commit = 'a'.repeat(40);
const input = { projectId: 'fixture', commit, preview: { pullRequest: 21, url: 'https://private-preview.test' } };
const container = 'c'.repeat(64);
const manifest = (sha = commit) => JSON.stringify({ sha, schema: 1 });
const bytes = (value: string) => ({ stdout: Buffer.from(value).toString('base64'), stderr: '', exitCode: 0 });

describe('private design acceptance preview build', () => {
  it('reads only static assets from the resolved container and notices a replaced preview', async () => {
    const resolveContainer = vi.fn(async () => container);
    const exec = vi.fn(async (command: string) => command.includes('cds-prebuilt-manifest.json') ? bytes(manifest()) : bytes('<main>build</main>'));
    const open = createDesignPreviewBuild(resolveContainer, { exec });
    const build = await open(input);
    expect(build).toBeDefined();
    expect(await build!.current()).toBe(true);
    expect(await build!.read('index.html')).toEqual(Buffer.from('<main>build</main>'));
    expect(await build!.read('assets/entry-X.js')).toEqual(Buffer.from('<main>build</main>'));
    expect(await build!.read('../state.json')).toBeUndefined();
    expect(await build!.read('assets/../../../state.json')).toBeUndefined();
    expect(exec.mock.calls.every(([command]) => command.includes(container + ':/app/cds/') && !command.includes('state.json'))).toBe(true);
    expect(resolveContainer).toHaveBeenCalledWith(input);
    resolveContainer.mockResolvedValue('d'.repeat(64));
    expect(await build!.current()).toBe(false);
  });

  it('rejects an unavailable container or untrusted build identity', async () => {
    const exec = vi.fn(async () => bytes(manifest('b'.repeat(40))));
    const invalid = createDesignPreviewBuild(async () => 'wrong-container', { exec });
    expect(await invalid(input)).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    const open = createDesignPreviewBuild(async () => container, { exec });
    expect(await open(input)).toBeUndefined();
  });
});
