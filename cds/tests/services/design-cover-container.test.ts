import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesignReferenceContainer } from '../../src/services/design-cover-container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
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
      return { stdout: JSON.stringify([batch[0] === 'second' ? null : thumbnail.toString('base64')]), stderr: '', exitCode: 0 };
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
    shell.addResponsePattern(/^docker start /, () => { throw Object.assign(new Error('fixture'), { code: 'deadline' }); });
    shell.addResponse('docker rm -f ' + id, { stdout: '', stderr: '', exitCode: 0 });
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capture = createDesignReferenceContainer(shell, async () => image);
    const result = [];
    for await (const item of capture(Buffer.from('fixture prototype'), targets)) result.push(item);
    expect(result).toEqual([]);
    expect(shell.commands.filter(command => command.startsWith('docker start '))).toHaveLength(2);
    expect(shell.commands.filter(command => command === 'docker rm -f ' + id)).toHaveLength(2);
    expect(diagnostic).toHaveBeenCalledWith('[design-browser] request failed', expect.objectContaining({ stage: 'run', reason: 'deadline' }));
  });
});
