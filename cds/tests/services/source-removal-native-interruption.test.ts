import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { JanitorService, createJanitorDockerAdapters } from '../../src/services/janitor.js';
import { StateService } from '../../src/services/state.js';
import { NoticeLedgerService, startNoticeLedger } from '../../src/services/notice-ledger.js';
import { worktreePathActivity } from '../../src/services/worktree-path-activity.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { IShellExecutor, BranchEntry } from '../../src/types.js';

const roots: string[] = [];
let closing = false;
const workers = new Set<{ pid: number; done: Promise<unknown> }>();
afterEach(async () => {
  closing = true;
  await Promise.all(
    [...workers].map(async (worker) => {
      try {
        process.kill(-worker.pid, 'SIGKILL');
      } catch {}
      await worker.done;
    }),
  );
  await flushAllJsonStateStores();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('actual native Git deletion interruption', () => {
  it.skipIf(process.platform !== 'linux').each([false, true])(
    'keeps partial-cache risk across rescans and verifies historical repair before recovery (missingGitPointer=%s)',
    async (removeGitPointer) => {
      closing = false;
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'source-native-interruption-')));
      roots.push(root);
      const stat = await fs.statfs(root);
      expect(
        stat.bavail * stat.bsize,
        'private files require2GiB workload budget plus6GiB reserve',
      ).toBeGreaterThan(8 * 1024 ** 3);
      const repo = path.join(root, 'repo');
      await fs.mkdir(repo);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      git('init', '-b', 'main');
      git('config', 'user.name', 'Native interruption regression');
      git('config', 'user.email', 'regression@example.invalid');
      await fs.writeFile(path.join(repo, 'sentinel'), 'protected historical content');
      git('add', '.');
      git('commit', '-m', '隔离保护基线');
      const protectedSha = git('rev-parse', 'HEAD');
      const base = path.join(root, 'worktrees'),
        bucket = path.join(base, 'project', '.deployment-sources', 'branch');
      await fs.mkdir(bucket, { recursive: true });
      const old = new Date(Date.now() - 4 * 3600000);
      const make = async (sha: string) => {
        const dir = path.join(bucket, randomUUID());
        git('worktree', 'add', '--detach', dir, sha);
        await fs.utimes(dir, old, old);
        return dir;
      };
      const active = await make(protectedSha),
        rollback = await make(protectedSha),
        inflight = await make(protectedSha),
        data = await make(protectedSha);
      await fs.mkdir(path.join(data, '.cds-run-data'));
      await fs.writeFile(path.join(data, '.cds-run-data', 'db'), 'business sentinel');
      await fs.utimes(data, old, old);
      const claim = worktreePathActivity.tryAcquire([inflight]);
      expect(claim).toBeTruthy();
      const branch = {
        id: 'branch',
        projectId: 'project',
        branch: 'main',
        createdAt: new Date().toISOString(),
        status: 'running',
        services: {
          active: { profileId: 'active', status: 'running', sourceCheckoutPath: active },
          rollback: { profileId: 'rollback', status: 'stopped', sourceCheckoutPath: rollback },
        },
      } as BranchEntry;
      const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
      const snapshot = async () => ({
        refs: JSON.stringify(branch),
        claim: worktreePathActivity.getStats(),
        objects: await Promise.all(
          [active, rollback, inflight, data].map(async (dir) => ({
            dir,
            head: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            hash: hash(await fs.readFile(path.join(dir, 'sentinel'))),
          })),
        ),
        businessHash: hash(await fs.readFile(path.join(data, '.cds-run-data', 'db'))),
      });
      const protectedBefore = await snapshot();
      const count = 4096,
        chunk = Buffer.alloc(4096, 69);
      await fs.mkdir(path.join(repo, 'many'));
      for (let start = 0; start < count; start += 32)
        await Promise.all(
          Array.from({ length: Math.min(32, count - start) }, (_, offset) =>
            fs.writeFile(path.join(repo, 'many', String(start + offset).padStart(6, '0')), chunk),
          ),
        );
      git('add', '.');
      git('commit', '-m', '隔离原生中断负载');
      const victimSha = git('rev-parse', 'HEAD'),
        victim = await make(victimSha);
      const gitPointer = path.join(victim, '.git'),
        originalPointer = await fs.readFile(gitPointer, 'utf8'),
        gitDirectory = execFileSync('git', ['-C', victim, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(),
        gitIdentity = await fs.stat(gitDirectory);
      const remaining = () => {
        try {
          return syncFs.readdirSync(path.join(victim, 'many')).length;
        } catch {
          return 0;
        }
      };
      let checkpoint: { remaining: number; pid: number; nativeGitConfirmed: boolean } | undefined;
      // Stop at a process boundary before exec, then observe actual native unlink.
      // This avoids turning a regression into a race against disk throughput.
      const bin = path.join(root, 'bin'),
        gate = path.join(root, 'remove-pid');
      await fs.mkdir(bin);
      await fs.writeFile(
        path.join(bin, 'git'),
        `#!/bin/sh
if [ "$1" = "--git-dir" ] && [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then
 printf '%s' "$$" > "$CAPACITY_TEST_REMOVE_PID"
 kill -STOP "$$"
fi
exec /usr/bin/git "$@"
`,
        { mode: 0o700 },
      );
      const state = new StateService(path.join(root, 'state.json'));
      state.addProject({
        id: 'project',
        slug: 'project',
        name: 'Private regression',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);
      state.addBranch(branch);
      const ledger = new NoticeLedgerService({ storePath: path.join(root, 'notices.json') });
      const subscription = startNoticeLedger({ ledger, outbound: null });
      const shell: IShellExecutor = {
        exec: async () => {
          throw new Error('Docker work is disabled in this private fixture');
        },
        execOwnedOperation: async (command, options) => {
          if (closing) throw new Error('Private regression executor is closed');
          options.beforeStart();
          const input = JSON.parse(options.stdin!);
          const interrupt = input.dir === victim && !checkpoint;
          const worker = spawn('/bin/sh', ['-c', command], {
            cwd: options.cwd,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: interrupt
              ? {
                  ...process.env,
                  PATH: bin + path.delimiter + process.env.PATH,
                  CAPACITY_TEST_REMOVE_PID: gate,
                }
              : process.env,
          });
          let stdout = '',
            stderr = '';
          worker.stdout.on('data', (c) => (stdout += c));
          worker.stderr.on('data', (c) => (stderr += c));
          const terminal = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) =>
            worker.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 })),
          );
          const owned = { pid: worker.pid!, done: terminal };
          workers.add(owned);
          void terminal.then(() => workers.delete(owned));
          worker.stdin.end(options.stdin);
          if (interrupt) {
            const deadline = Date.now() + 15000;
            while (!syncFs.existsSync(gate) && Date.now() < deadline && worker.exitCode === null)
              await new Promise((resolve) => setTimeout(resolve, 1));
            expect(syncFs.existsSync(gate), 'native removal must reach its explicit process checkpoint').toBe(
              true,
            );
            const text = (await fs.readFile(gate, 'utf8')).trim();
            expect(text).toMatch(/^[1-9][0-9]*$/);
            const pid = Number(text);
            expect(pid).toBeGreaterThan(1);
            const watcher = syncFs.watch(path.join(victim, 'many'), (event, name) => {
              if (
                checkpoint ||
                event !== 'rename' ||
                !name ||
                syncFs.existsSync(path.join(victim, 'many', String(name)))
              )
                return;
              try {
                const args = syncFs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
                if (!args.startsWith('/usr/bin/git' + String.fromCharCode(0))) return;
                process.kill(pid, 'SIGSTOP');
                const left = remaining();
                checkpoint = { remaining: left, pid, nativeGitConfirmed: true };
                process.kill(pid, 'SIGKILL');
              } catch {
                /* A completed deletion is not evidence of interruption. */
              }
            });
            try {
              process.kill(pid, 'SIGCONT');
              await terminal;
            } finally {
              watcher.close();
            }
          }
          return terminal;
        },
      };
      const files = {
        ...createJanitorDockerAdapters(shell).orphanWorktreeFs,
        listMountedHostPaths: async () => [],
      };
      let now = Date.now(),
        unknownDisk = true;
      const service = new JanitorService(
        state,
        {
          enabled: false,
          worktreeTTLDays: 7,
          diskWarnPercent: 80,
          sweepIntervalSeconds: 3600,
          dockerPrune: false,
          imageRetention: false,
        },
        base,
        { now: () => now },
        () => (unknownDisk ? null : { totalBytes: 1000, freeBytes: 500 }),
        undefined,
        undefined,
        files,
      );
      const evidence: Record<string, unknown> = {
        provenance:
          'real isolated Git/files/native child SIGKILL + production Janitor adapter and ledger; injected disk observation and clock only',
        count,
        contentBytes: count * chunk.length,
        victimSha,
      };
      try {
        const first = await service.sweep();
        expect(checkpoint).toBeTruthy();
        expect(checkpoint!.nativeGitConfirmed).toBe(true);
        expect(checkpoint!.remaining).toBeGreaterThan(0);
        expect(checkpoint!.remaining).toBeLessThan(count);
        unknownDisk = false;
        now += 3 * 3600000;
        const retries = [await service.sweep(), await service.sweep()];
        Object.assign(evidence, {
          checkpoint,
          first,
          retries,
          protectedBefore,
          protectedAfter: await snapshot(),
          noticesBeforeRepair: ledger.list(),
          remainingAfterRetry: remaining(),
        });
        expect(await snapshot()).toEqual(protectedBefore);
        expect(
          ledger.list().some((n) => n.eventType === 'capacity.recovered'),
          'partial native deletion must not announce recovery after disk readings recover',
        ).toBe(false);
        expect(first.deploymentSources!.failed.map((x) => x.path)).toContain(victim);
        expect(retries.every((r) => r.deploymentSources!.failed.some((x) => x.path === victim))).toBe(true);
        // The test operator repairs only this private known historical cache. The
        // implementation never restores files, force-cleans, or widens eligibility.
        // Native unlink order is filesystem-dependent: .git may disappear before
        // tracked files. Restore only the fixture's previously observed pointer,
        // after checking its original registration and historical HEAD still exist.
        if (removeGitPointer) await fs.rm(gitPointer, { force: true });
        const currentGitIdentity = await fs.stat(gitDirectory);
        expect([currentGitIdentity.dev, currentGitIdentity.ino]).toEqual([gitIdentity.dev, gitIdentity.ino]);
        expect((await fs.readFile(path.join(gitDirectory, 'gitdir'), 'utf8')).trim()).toBe(gitPointer);
        expect(execFileSync('git', ['--git-dir', gitDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(victimSha);
        let pointerRestored = false;
        try {
          expect(await fs.readFile(gitPointer, 'utf8')).toBe(originalPointer);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await fs.writeFile(gitPointer, originalPointer, { flag: 'wx' });
          pointerRestored = true;
        }
        if (removeGitPointer) expect(pointerRestored).toBe(true);
        expect(await fs.readFile(gitPointer, 'utf8')).toBe(originalPointer);
        Object.assign(evidence, { removeGitPointer, pointerRestored, originalGitRegistrationVerified: true });
        execFileSync('git', ['-C', victim, 'restore', `--source=${victimSha}`, '--worktree', '--', '.']);
        expect((await fs.readdir(path.join(victim, 'many'))).length).toBe(count);
        expect(hash(await fs.readFile(path.join(victim, 'many', '000000')))).toBe(hash(chunk));
        expect(execFileSync('git', ['-C', victim, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
          victimSha,
        );
        const recovered = await service.sweep();
        expect(recovered.deploymentSources!.removed).toContain(victim);
        expect(ledger.list().some((n) => n.eventType === 'capacity.recovered')).toBe(true);
        expect(await snapshot()).toEqual(protectedBefore);
        Object.assign(evidence, {
          recovered,
          noticesAfterRepair: ledger.list(),
          protectionVerified: true,
          historicalRepairVerified: true,
        });
      } finally {
        service.stop();
        subscription.stop();
        claim!.release();
        if (process.env.CAPACITY_NATIVE_INTERRUPTION_EVIDENCE)
          await fs.writeFile(
            process.env.CAPACITY_NATIVE_INTERRUPTION_EVIDENCE + (removeGitPointer ? '.missing-git-pointer.json' : ''),
            JSON.stringify(evidence, null, 2),
          );
      }
    },
    30000,
  );
});
