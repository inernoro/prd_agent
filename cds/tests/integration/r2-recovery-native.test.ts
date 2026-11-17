/** Opt-in native Docker/Mongo8: CDS_TEST_MONGO_IMAGE must name an already cached image. No production data or R2 network. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMongoR2RecoveryDrill, type RecoveryDrillCommandRunner } from '../../src/services/infra-r2-recovery-drill.js';
const exec = promisify(execFile), image = process.env.CDS_TEST_MONGO_IMAGE;
const ownerLabel = 'org.cds.recovery-native-test';
async function docker(args: readonly string[]) {
  try { const r = await exec('docker', [...args], { timeout: 30_000, maxBuffer: 2 * 1024 ** 2, env: { PATH: process.env.PATH, HOME: process.env.HOME } }); return { exitCode: 0, ...r }; }
  catch (e) { const r = e as { code?: number; stdout?: string; stderr?: string }; return { exitCode: typeof r.code === 'number' ? r.code : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; }
}
describe.skipIf(!image)('原生R2恢复清场（合成归档、替代传输）', () => {
  it('真实Mongo8恢复、损坏归档和未确认清场均遵守隔离与退役边界', async () => {
    const token = crypto.randomBytes(16).toString('hex');
    let source = '';
    const held: Array<{ id: string; label: string; root: string }> = [];
    const evidence: Record<string, unknown> = { syntheticOnly: true, realR2Transport: false, productionData: false, mongoImage: image };
    try {
      const create = await docker(['create', '--name', `cds-recovery-fixture-${token}`, '--label', `${ownerLabel}=${token}`, '--network', 'none', '--pull', 'never',
        '--memory', '1610612736', '--memory-swap', '1610612736', '--cpus', '1', '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
        '--tmpfs', '/data/db:rw,size=1073741824', '--tmpfs', '/data/configdb:rw,size=16777216', image!, '--bind_ip', '127.0.0.1', '--wiredTigerCacheSizeGB', '0.25']);
      source = create.stdout.trim(); expect(create.exitCode).toBe(0); expect(source).toMatch(/^[a-f0-9]{64}$/);
      expect((await docker(['start', source])).exitCode).toBe(0);
      let ready = false;
      for (let n = 0; n < 40; n++) {
        if ((await docker(['exec', source, 'mongosh', '--quiet', '--eval', 'quit(db.adminCommand({ping:1}).ok===1?0:1)'])).exitCode === 0) { ready = true; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(ready).toBe(true);
      const seeded = await docker(['exec', source, 'mongosh', '--quiet', '--eval', 'const c=db.getSiblingDB("synthetic_recovery").rows;c.insertMany(Array.from({length:100},(_,i)=>({_id:i,payload:"qa-"+i})));c.createIndex({payload:1},{unique:true});']);
      expect(seeded.exitCode, seeded.stderr.slice(0, 600)).toBe(0);
      const dump = await docker(['exec', source, 'sh', '-c', 'mongodump --host 127.0.0.1 --db synthetic_recovery --archive --gzip | base64 -w0']);
      expect(dump.exitCode).toBe(0);
      const body = Buffer.from(dump.stdout.trim(), 'base64'); expect(body.length).toBeGreaterThan(100);
      const run = async (corrupt = false, hold = false) => {
        const bytes = corrupt ? Buffer.from('invalid synthetic gzip archive') : body;
        let own: { id: string; label: string; root: string } | undefined;
        const runner: RecoveryDrillCommandRunner = async (command, args) => {
          expect(command).toBe('docker');
          // Fail before the native removal, leaving an actual owned container to reconcile.
          if (hold && args[0] === 'rm') throw new Error('intentional-unconfirmed-cleanup');
          const r = await docker(args);
          if (args[0] === 'create' && r.exitCode === 0) {
            const label = args[args.indexOf('--label') + 1].split('=')[1];
            const root = path.dirname(args[args.indexOf('--mount') + 1].match(/src=([^,]+)/)![1]);
            own = { id: r.stdout.trim(), label, root }; held.push(own);
            const raw = await docker(['inspect', own.id]); expect(raw.exitCode).toBe(0);
            const current = JSON.parse(raw.stdout)[0];
            expect(current.HostConfig.NetworkMode).toBe('none'); expect(current.HostConfig.PortBindings ?? {}).toEqual({});
            expect(current.Mounts.filter((m: { Type: string }) => m.Type === 'volume')).toHaveLength(0);
            expect(current.Mounts.filter((m: { Type: string }) => m.Type === 'bind')).toMatchObject([{ RW: false }]);
          }
          return r;
        };
        const fetchImpl: typeof fetch = async (_url, init) => init?.method === 'HEAD'
          ? new Response(null, { headers: { 'content-length': String(bytes.length), 'x-amz-meta-sha256': crypto.createHash('sha256').update(bytes).digest('hex') } }) : new Response(bytes);
        const promise = runMongoR2RecoveryDrill({ config: { endpoint: 'https://storage.invalid', bucket: 'synthetic', prefix: '', accessKeyId: 'fake', secretAccessKey: 'fake' },
          objectKey: 'synthetic.archive.gz', mongoImage: image, fetchImpl, commandRunner: runner,
          maxArchiveBytes: 1024 ** 2, dataBytes: 1024 ** 3, memoryBytes: 1536 * 1024 ** 2, timeoutMs: 60_000, readinessDelayMs: 250 });
        if (hold) { await expect(promise).rejects.toThrow('清场未确认'); expect(fs.existsSync(path.join(own!.root, 'backup.archive.gz'))).toBe(true); expect((await docker(['inspect', own!.id])).exitCode).toBe(0); }
        else if (corrupt) await expect(promise).rejects.toThrow('恢复离机备份失败');
        else expect(await promise).toMatchObject({ databaseCount: 1, collectionCount: 1, nonEmptyCollectionCount: 1 });
        if (!hold) { expect((await docker(['inspect', own!.id])).exitCode).not.toBe(0); expect(fs.existsSync(own!.root)).toBe(false); }
      };
      await run(); await run(true); await run(false, true);
      evidence.passed = true;
    } finally {
      for (const own of held) {
        const inspect = await docker(['inspect', own.id]);
        if (inspect.exitCode === 0) {
          const current = JSON.parse(inspect.stdout)[0]; expect(current.Config.Labels['org.cds.recovery-drill']).toBe(own.label);
          expect((await docker(['rm', '-f', '-v', own.id])).exitCode).toBe(0);
        }
        if (fs.existsSync(own.root)) { expect(fs.readdirSync(own.root)).toEqual(['backup.archive.gz']); fs.unlinkSync(path.join(own.root, 'backup.archive.gz')); fs.rmdirSync(own.root); }
      }
      if (source) {
        const inspect = await docker(['inspect', source]); expect(JSON.parse(inspect.stdout)[0].Config.Labels[ownerLabel]).toBe(token);
        expect((await docker(['rm', '-f', '-v', source])).exitCode).toBe(0);
      }
      const current = await docker(['ps', '-aq', '--filter', `label=${ownerLabel}=${token}`]); expect(current.exitCode).toBe(0); expect(current.stdout.trim()).toBe('');
      evidence.privateCleanupConfirmed = true;
      if (process.env.CDS_RECOVERY_EVIDENCE_PATH) fs.writeFileSync(process.env.CDS_RECOVERY_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
    }
  }, 120_000);
});
