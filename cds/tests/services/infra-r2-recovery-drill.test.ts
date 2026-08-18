import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  runMongoR2RecoveryDrill,
  type RecoveryDrillCommandRunner,
} from '../../src/services/infra-r2-recovery-drill.js';

const config = {
  endpoint: 'https://storage.invalid',
  bucket: 'backup',
  prefix: 'cds',
  accessKeyId: 'access-id',
  secretAccessKey: 'secret-key',
};

describe('R2 Mongo 恢复演练', () => {
  it('在无端口临时容器中恢复并读取非空集合后清理', async () => {
    const body = Buffer.from('mongo-archive');
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'HEAD') {
        return new Response('', { status: 200, headers: { 'content-length': String(body.length), 'x-amz-meta-sha256': sha256 } });
      }
      return new Response(body, { status: 200 });
    };
    const calls: string[][] = [];
    const runner: RecoveryDrillCommandRunner = async (_command, args) => {
      const copy = [...args];
      calls.push(copy);
      if (copy[0] === 'exec' && copy.some((value) => value.includes('listDatabases:1,nameOnly:true'))) {
        return { exitCode: 0, stdout: '{"databaseCount":2,"collectionCount":7,"nonEmptyCollectionCount":5}\n', stderr: '' };
      }
      return { exitCode: 0, stdout: copy[0] === 'run' ? 'container-id\n' : '', stderr: '' };
    };

    const result = await runMongoR2RecoveryDrill({
      config,
      objectKey: 'cds/state.archive.gz',
      fetchImpl: fetchImpl as typeof fetch,
      commandRunner: runner,
      readinessAttempts: 1,
      readinessDelayMs: 0,
    });

    expect(result).toMatchObject({ databaseCount: 2, collectionCount: 7, nonEmptyCollectionCount: 5, bytes: body.length, sha256 });
    const run = calls.find((args) => args[0] === 'run');
    expect(run).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(run).not.toContain('-p');
    expect(calls.some((args) => args[0] === 'exec' && args.includes('mongorestore'))).toBe(true);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-f']);
  });

  it('恢复失败也会移除临时容器', async () => {
    const body = Buffer.from('mongo-archive');
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => init?.method === 'HEAD'
      ? new Response('', { status: 200, headers: { 'content-length': String(body.length), 'x-amz-meta-sha256': sha256 } })
      : new Response(body, { status: 200 });
    const calls: string[][] = [];
    const runner: RecoveryDrillCommandRunner = async (_command, args) => {
      const copy = [...args];
      calls.push(copy);
      if (copy.includes('mongorestore')) return { exitCode: 2, stdout: '', stderr: 'restore rejected' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(runMongoR2RecoveryDrill({
      config,
      objectKey: 'cds/state.archive.gz',
      fetchImpl: fetchImpl as typeof fetch,
      commandRunner: runner,
      readinessAttempts: 1,
      readinessDelayMs: 0,
    })).rejects.toThrow('恢复离机备份失败');
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-f']);
  });
});
