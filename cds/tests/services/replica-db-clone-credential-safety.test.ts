import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dockerHarness = vi.hoisted(() => ({
  calls: [] as Array<{ argv: string[]; stdin: string }>,
  envFiles: [] as Array<{ path: string; mode: number; contents: string }>,
  failDump: false,
  canary: '',
}));

vi.mock('../../src/routes/infra-data.js', () => ({
  detectInfraDataKind: (image: string) => (/mongo/i.test(image) ? 'mongo' : null),
  maskSecretValues: (text: string, secrets: string[]) => secrets.reduce(
    (masked, secret) => (secret ? masked.split(secret).join('***') : masked),
    text,
  ),
  runDockerExec: async (argv: string[], stdin: string) => {
    dockerHarness.calls.push({ argv: [...argv], stdin });
    const envIndex = argv.indexOf('--env-file');
    if (envIndex >= 0) {
      const envPath = argv[envIndex + 1];
      dockerHarness.envFiles.push({
        path: envPath,
        mode: fs.statSync(envPath).mode & 0o777,
        contents: fs.readFileSync(envPath, 'utf8'),
      });
    }
    const joined = argv.join(' ');
    if (joined.includes('stats().dataSize')) return { code: 0, stdout: '0\n', stderr: '', truncated: false };
    if (joined.includes('mongodump') && dockerHarness.failDump) {
      return {
        code: 9,
        stdout: '',
        stderr: `raw=${dockerHarness.canary} encoded=${encodeURIComponent(dockerHarness.canary)}`,
        truncated: false,
      };
    }
    if (argv[0] === 'exec' && joined.includes('runCommand({ping:1})')) {
      return { code: 0, stdout: '1\n', stderr: '', truncated: false };
    }
    if (argv[0] === 'port') return { code: 0, stdout: '127.0.0.1:32123\n', stderr: '', truncated: false };
    return { code: 0, stdout: '', stderr: '', truncated: false };
  },
}));

import { cloneReplicaDb, dropReplicaDb, mongoAdminEval } from '../../src/services/replica-db-clone.js';
import type { InfraService, ReplicaDbSnapshot } from '../../src/types.js';

function mongoTarget(password: string) {
  return {
    engine: 'mongo' as const,
    sourceDb: 'appdb',
    envKeys: ['MongoDB__DatabaseName'],
    connEnvKeys: ['MongoDB__ConnectionString'],
    infra: {
      id: 'mongodb', projectId: 'project-a', name: 'MongoDB', dockerImage: 'mongo:7',
      containerPort: 27017, hostPort: 27018, containerName: 'mongo-main', status: 'running',
      env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: password },
      volumes: [], createdAt: '2026-09-06T00:00:00.000Z',
    } as InfraService,
  };
}

describe('replica Mongo credential transport', () => {
  beforeEach(() => {
    dockerHarness.calls.length = 0;
    dockerHarness.envFiles.length = 0;
    dockerHarness.failDump = false;
    dockerHarness.canary = 'mongo-canary-p@ss/$ x';
  });

  afterEach(() => {
    for (const entry of dockerHarness.envFiles) {
      if (fs.existsSync(entry.path)) fs.rmSync(entry.path, { force: true });
    }
  });

  it('keeps mongosh admin and drop passwords out of argv and masks command output', async () => {
    const encoded = encodeURIComponent(dockerHarness.canary);
    const env = { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: dockerHarness.canary };
    const admin = await mongoAdminEval('mongo-main', 27017, env, 'print(1)');
    expect(admin.stdout + admin.stderr).not.toContain(dockerHarness.canary);
    expect(admin.stdout + admin.stderr).not.toContain(encoded);

    const snapshot = {
      id: 'rsdb-a', profileId: 'api', memberId: 'guard-1', engine: 'mongo',
      sourceDb: 'appdb', dbName: 'appdb_rs_guard_1', infraContainer: 'mongo-main',
      clonedAt: '2026-09-06T00:00:00.000Z',
    } as ReplicaDbSnapshot;
    await dropReplicaDb(snapshot, env);

    for (const call of dockerHarness.calls) {
      const serialized = JSON.stringify(call.argv);
      expect(serialized).not.toContain(dockerHarness.canary);
      expect(serialized).not.toContain(encoded);
      if (call.argv.includes('mongosh')) expect(call.argv.at(-1)).toBe('--password');
    }
    expect(dockerHarness.calls.filter((call) => call.argv.includes('mongosh')).every(
      (call) => call.stdin === `${dockerHarness.canary}\n`,
    )).toBe(true);
  });

  it('uses a mode-600 env-file and config-based dump/restore, then removes the env-file', async () => {
    const encoded = encodeURIComponent(dockerHarness.canary);
    const output: string[] = [];
    const result = await cloneReplicaDb({
      target: mongoTarget(dockerHarness.canary),
      memberId: 'guard-1', profileId: 'api', branchId: 'project-a-main',
      instanceId: 'instance-a', publishHost: '172.17.0.1', onOutput: (line) => output.push(line),
    });

    expect(result.snapshot.dedicatedHostPort).toBe(32123);
    expect(dockerHarness.envFiles.length).toBeGreaterThanOrEqual(3);
    for (const entry of dockerHarness.envFiles) {
      expect(entry.mode).toBe(0o600);
      expect(fs.existsSync(entry.path)).toBe(false);
    }
    for (const call of dockerHarness.calls) {
      const serialized = JSON.stringify(call.argv);
      expect(serialized).not.toContain(dockerHarness.canary);
      expect(serialized).not.toContain(encoded);
    }
    const helperScripts = dockerHarness.calls.map((call) => call.argv.at(-1) || '').filter((arg) => /mongodump|mongorestore/.test(arg));
    expect(helperScripts).toHaveLength(2);
    expect(helperScripts.every((script) => script.includes('--config "$auth_file"'))).toBe(true);
    expect(helperScripts.every((script) => !script.includes('RS_MONGO_PW'))).toBe(true);
    expect(output.join('\n')).not.toContain(dockerHarness.canary);
    expect(output.join('\n')).not.toContain(encoded);
  });

  it('removes the env-file and masks raw and encoded secrets when dump fails', async () => {
    dockerHarness.failDump = true;
    const encoded = encodeURIComponent(dockerHarness.canary);
    let message = '';
    try {
      await cloneReplicaDb({
        target: mongoTarget(dockerHarness.canary),
        memberId: 'guard-1', profileId: 'api', branchId: 'project-a-main',
        instanceId: 'instance-a', publishHost: '172.17.0.1',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('mongo dump');
    expect(message).not.toContain(dockerHarness.canary);
    expect(message).not.toContain(encoded);
    expect(dockerHarness.envFiles.length).toBeGreaterThan(0);
    expect(dockerHarness.envFiles.every((entry) => !fs.existsSync(entry.path))).toBe(true);
  });

  it('removes the temporary directory when env-file permission setup fails', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('cds-rs-mongo-auth-')));
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementationOnce(() => {
      throw new Error('simulated chmod failure');
    });
    try {
      await expect(cloneReplicaDb({
        target: mongoTarget(dockerHarness.canary),
        memberId: 'guard-1', profileId: 'api', branchId: 'project-a-main',
        instanceId: 'instance-a', publishHost: '172.17.0.1',
      })).rejects.toThrow(/simulated chmod failure/);
    } finally {
      chmod.mockRestore();
    }
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('cds-rs-mongo-auth-'));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });
});
