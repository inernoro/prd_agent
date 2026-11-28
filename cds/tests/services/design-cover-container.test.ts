import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesignAcceptanceContainer, createDesignReferenceContainer } from '../../src/services/design-cover-container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { DesignAcceptanceCapture } from '../../src/services/design-acceptance-browser.js';
import type { DesignReferenceTarget } from '../../src/services/design-framework-browser.js';

const id = 'a'.repeat(64);
const image = 'ghcr.io/example/cds/cds-design-cover:sha-' + 'b'.repeat(40);
const thumbnail = Buffer.from('test thumbnail');
const targets: DesignReferenceTarget[] = ['first', 'second', 'third', 'fourth', 'fifth'].map(id => ({
  screen: { id, name: id, route: '#/' + id, viewport: 'desktop', themes: ['light'], impl: null }, theme: 'light',
}));

afterEach(() => vi.restoreAllMocks());

describe('isolated design reference capture', () => {
  it('recovers from an interrupted batch and keeps capturing after a single screen fails', async () => {
    const shell = new MockShellExecutor();
    const attempts: string[][] = [];
    shell.addResponsePattern(/^docker create /, () => ({ stdout: id, stderr: '', exitCode: 0 }));
    shell.addResponse('docker rm -f ' + id, { stdout: '', stderr: '', exitCode: 0 });
    shell.addResponsePattern(/^docker start /, (_match, options) => {
      const request = JSON.parse(options!.stdin!) as { references: DesignReferenceTarget[] };
      const batch = request.references.map(target => target.screen.id);
      attempts.push(batch);
      if (batch.length > 1) return { stdout: '', stderr: 'synthetic private renderer details', exitCode: 137 };
      if (batch[0] === 'second') return { stdout: '', stderr: 'synthetic single screen failure', exitCode: 137 };
      return { stdout: JSON.stringify([thumbnail.toString('base64')]), stderr: '', exitCode: 0 };
    });
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capture = createDesignReferenceContainer(shell, async () => image);
    const result = [];
    for await (const item of capture(Buffer.from('fixture prototype'), targets)) result.push(item);
    expect(attempts).toEqual([['first', 'second', 'third', 'fourth'], ...targets.map(target => [target.screen.id])]);
    expect(result.map(item => [item.screen.id, item.bytes])).toEqual([
      ['first', thumbnail], ['third', thumbnail], ['fourth', thumbnail], ['fifth', thumbnail],
    ]);
    expect(diagnostic).toHaveBeenCalledWith('[design-browser] request failed', expect.objectContaining({ stage: 'run', exitCode: 137 }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('synthetic private renderer details');
    expect(shell.commands.filter(command => command === 'docker rm -f ' + id)).toHaveLength(attempts.length);
  });

  it('bounds retries when the renderer cannot start even with one screen', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/^docker create /, () => ({ stdout: id, stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker start /, () => { throw Object.assign(new Error('fixture'), { code: 'capacity' }); });
    shell.addResponse('docker rm -f ' + id, { stdout: '', stderr: '', exitCode: 0 });
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capture = createDesignReferenceContainer(shell, async () => image);
    const result = [];
    for await (const item of capture(Buffer.from('fixture prototype'), targets)) result.push(item);
    expect(result).toEqual([]);
    expect(shell.commands.filter(command => command.startsWith('docker start '))).toHaveLength(1);
    expect(shell.commands.filter(command => command === 'docker rm -f ' + id)).toHaveLength(1);
    expect(diagnostic).toHaveBeenCalledWith('[design-browser] request failed', expect.objectContaining({ stage: 'run', reason: 'capacity' }));
  });

  it('bounds a renderer outage even when every individual capture times out', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/^docker create /, () => ({ stdout: id, stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker start /, () => { throw Object.assign(new Error('fixture'), { code: 'deadline' }); });
    shell.addResponse('docker rm -f ' + id, { stdout: '', stderr: '', exitCode: 0 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capture = createDesignReferenceContainer(shell, async () => image);
    const result = [];
    for await (const item of capture(Buffer.from('fixture prototype'), targets)) result.push(item);
    expect(result).toEqual([]);
    expect(shell.commands.filter(command => command.startsWith('docker start '))).toHaveLength(3);
    expect(shell.commands.filter(command => command === 'docker rm -f ' + id)).toHaveLength(3);
  });

  it('gives the remaining screenshots separate browser sessions when retrying a partial batch', async () => {
    const shell = new MockShellExecutor();
    const attempts: Array<{ ids: string[]; retry?: boolean; timeout?: number }> = [];
    shell.addResponsePattern(/^docker create /, () => ({ stdout: id, stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker start /, (_match, options) => {
      const request = JSON.parse(options!.stdin!) as { references: DesignReferenceTarget[]; retry?: boolean };
      attempts.push({ ids: request.references.map(target => target.screen.id), retry: request.retry, timeout: options?.timeout });
      const result = request.references.map(() => request.retry && request.references.length === 1 ? thumbnail.toString('base64') : null);
      return { stdout: JSON.stringify(result), stderr: '', exitCode: 0 };
    });
    shell.addResponse('docker rm -f ' + id, { stdout: '', stderr: '', exitCode: 0 });
    const capture = createDesignReferenceContainer(shell, async () => image);
    const result = [];
    for await (const item of capture(Buffer.from('fixture prototype'), targets.slice(1, 3), true)) result.push(item);
    expect(attempts.map(attempt => attempt.ids)).toEqual([['second'], ['third']]);
    expect(attempts.every(({ retry, timeout }) => retry === true && (timeout ?? 0) > 40_000)).toBe(true);
    expect(result.map(item => [item.screen.id, item.bytes])).toEqual([['second', thumbnail], ['third', thumbnail]]);
  });
});

describe('isolated installed design acceptance', () => {
  it('binds the worker to the installed build and the same immutable input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cds-evidence-'));
    const commit = 'b'.repeat(40);
    const blueprint = Buffer.from('fixture design');
    const shell = new MockShellExecutor();
    const version = {
      createdAt: '2026-11-28T00:00:00Z', notes: 'extra fixture metadata',
      delivery: { files: [{ path: 'src/fixtures.ts', title: 'extra fixture title' }] },
    };
    const captureInput: Parameters<DesignAcceptanceCapture>[0] = {
      projectId: 'fixture-project', commit, prototype: blueprint, rules: [], theme: 'light',
      screen: { ...targets[0].screen, impl: '/design?project=fixture-project' },
      version,
    };
    const pair = { fixtureDigest: 'c'.repeat(64), reference: thumbnail.toString('base64'),
      implementation: thumbnail.toString('base64'), checks: {}, rules: {} };
    const requests: Array<{ commit: string; buildDigest: string; prototype: string }> = [];
    shell.addResponsePattern(/^docker create /, () => ({ stdout: id, stderr: '', exitCode: 0 }));
    shell.addResponse('docker rm -f ' + id, { stdout: '', stderr: '', exitCode: 0 });
    shell.addResponsePattern(/^docker start /, (_match, options) => {
      const request = JSON.parse(options!.stdin!);
      requests.push(request);
      return { stdout: JSON.stringify({ ok: true, result: pair }), stderr: '', exitCode: 0 };
    });
    try {
      await mkdir(path.join(root, 'assets'));
      await writeFile(path.join(root, '.build-sha'), commit + '\n');
      await writeFile(path.join(root, 'index.html'), '<script src="/assets/app.js"></script>');
      await writeFile(path.join(root, 'assets', 'app.js'), 'draft example one');
      const capture = createDesignAcceptanceContainer(shell, async () => image, root);
      const result = await capture(captureInput);
      expect(result).toMatchObject({ fixtureDigest: pair.fixtureDigest, reference: thumbnail, implementation: thumbnail });
      expect(requests[0]).toMatchObject({ commit, prototype: blueprint.toString('base64'), buildDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(requests[0]).toHaveProperty('version', {
        createdAt: version.createdAt, delivery: { files: [{ path: 'src/fixtures.ts' }] },
      });
      expect(shell.commands[0]).toContain('--network=none --read-only');
      expect(shell.commands[0]).not.toMatch(/--mount|--volume/);
      await writeFile(path.join(root, '.web-input-sha'), 'source-mode-build-stamp');
      await capture(captureInput);
      expect(requests[1].buildDigest).toEqual(requests[0].buildDigest);
      await writeFile(path.join(root, 'assets', 'app.js'), 'draft example two');
      await capture(captureInput);
      expect(requests[2].buildDigest).not.toEqual(requests[0].buildDigest);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
