import { describe, expect, it } from 'vitest';
import { admitCandidateCapacity } from '../../src/services/candidate-capacity.js';
import type { StateService } from '../../src/services/state.js';
import type { IShellExecutor } from '../../src/types.js';
const id = 'a'.repeat(64);
function fixture(lines: string, memory = 3 * 1024 ** 3, runs: any[] = []) {
  const commands: string[] = [];
  const shell = { exec: async (command: string) => {
    commands.push(command);
    return { exitCode: 0, stderr: '', stdout: command.startsWith('docker info') ? JSON.stringify({ MemTotal: memory, NCPU: 4 }) : lines };
  } } as IShellExecutor;
  const state = { getDeploymentRuns: () => runs } as StateService;
  return { shell, state, commands };
}
describe('candidate capacity based on actual Daemon and unreleased reservations', () => {
  it('counts actual running containers regardless of canonical error or missing branch state', async () => {
    const f = fixture([JSON.stringify({ ID: id, Names: 'error-but-running' }), JSON.stringify({ ID: 'b'.repeat(64), Names: 'foreign' })].join('\n'), 1.5 * 1024 ** 3);
    await expect(admitCandidateCapacity(f.state, f.shell, { assertCurrent: () => {} })).rejects.toThrow('candidate_capacity_exhausted');
    expect(f.commands).toHaveLength(2);
  });
  it('deduplicates running identities while retaining both unresolved graphs even for terminal runs', async () => {
    const graph = (names: string[]) => Object.fromEntries(names.map(name => [name, { containerName: name }]));
    const f = fixture(JSON.stringify({ ID: id, Names: 'old' }), 3 * 1024 ** 3,
      [{ status: 'failed', candidate: { phase: 'reconciling', serving: graph(['old']), services: graph(['new', 'unknown-create', 'another', 'fifth']) } }]);
    await expect(admitCandidateCapacity(f.state, f.shell, { assertCurrent: () => {} })).rejects.toThrow('candidate_capacity_exhausted');
    f.state.getDeploymentRuns = () => [{ candidate: { phase: 'released', serving: graph(['old']), services: graph(['new']) } }] as any;
    expect(await admitCandidateCapacity(f.state, f.shell, { assertCurrent: () => {} })).toMatchObject({ occupied: 1, max: 4 });
  });
  it.each(['not-json', JSON.stringify({ ID: 'short', Names: 'old' }), JSON.stringify({ ID: id })])('fails closed for unknown runtime data %s', async lines => {
    const f = fixture(lines);
    await expect(admitCandidateCapacity(f.state, f.shell, { assertCurrent: () => {} })).rejects.toThrow('candidate_capacity_unknown');
  });
  it('rejects invalid Daemon resources and superseded snapshots before admission', async () => {
    const f = fixture('', 0);
    await expect(admitCandidateCapacity(f.state, f.shell, { assertCurrent: () => {} })).rejects.toThrow('candidate_capacity_unknown');
    const valid = fixture('', 3 * 1024 ** 3); let calls = 0;
    await expect(admitCandidateCapacity(valid.state, valid.shell, { assertCurrent: () => { if (++calls === 2) throw new Error('new-owner'); } }))
      .rejects.toThrow('new-owner');
    expect(valid.commands).toHaveLength(1);
  });
});
