import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cleanObservationGroup, findObservationOwners } from '../../src/services/observation-process-group.js';

const observed = vi.hoisted(() => ({ groups: [] as number[], ownerQueryPids: [] as number[] }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn((...args: any[]) => {
    const callback = args.pop();
    return (actual.execFile as any)(...args, (error: unknown, stdout: string, stderr: string) => {
      if (args[0] === 'ps' && args[1].includes('pid=,pgid=,stat=')) {
        for (const line of stdout.trim().split('\n').filter(Boolean)) observed.groups.push(Number(line.trim().split(/\s+/)[1]));
      }
      if (args[0] === 'ps' && args[1].some((arg: string) => arg.includes('args='))) {
        for (const line of stdout.trim().split('\n').filter(Boolean)) observed.ownerQueryPids.push(Number(line.trim().split(/\s+/)[0]));
      }
      callback(error, stdout, stderr);
    });
  }) };
});
const roots: ChildProcess[] = [];
async function tree(): Promise<{ root: ChildProcess; descendants: number[] }> {
  const root = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn('/bin/sh',['-c','sleep 30 & echo $!; wait'],{stdio:['ignore','pipe','ignore']});
    let raw='';child.stdout.on('data',data=>{raw+=data;if(raw.includes('\\n'))console.log(JSON.stringify([child.pid,Number(raw.trim())]));});
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  roots.push(root);
  const descendants = await new Promise<number[]>((resolve, reject) => {
    let raw = ''; root.stdout!.on('data', data => { raw += data; if (raw.includes('\n')) resolve(JSON.parse(raw.trim())); });
    root.once('error', reject);
  });
  expect(descendants.every(pid => Number.isSafeInteger(pid) && pid > 1)).toBe(true);
  return { root, descendants };
}
afterEach(async () => {
  vi.mocked(execFile).mockClear(); observed.groups.length = 0; observed.ownerQueryPids.length = 0;
  await Promise.all(roots.splice(0).map(root => cleanObservationGroup(root.pid!)));
});
describe('真实私有进程组回收', () => {
  it.runIf(process.platform === 'darwin')('仅核查完整私有argv归属，前缀相似的无关进程不被读取或回收', async () => {
    const owner = `cds-observation-${randomBytes(16).toString('hex')}`;
    const launch = (token: string) => {
      const root = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)', '--', token],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      roots.push(root); return root;
    };
    const target = launch(owner), unrelated = launch(`${owner}-other`);
    await Promise.all([target, unrelated].map(root => new Promise<void>((resolve, reject) => {
      root.stdout!.once('data', () => resolve()); root.once('error', reject);
    })));
    observed.ownerQueryPids.length = 0;
    expect(await findObservationOwners(owner)).toEqual([{ pid: target.pid, group: target.pid }]);
    expect(observed.ownerQueryPids).toEqual([target.pid]);
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    expect(await findObservationOwners(`cds-observation-${randomBytes(16).toString('hex')}`)).toEqual([]);
  });
  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('只读取目标组，清理真实父子孙进程并保留另一组', async () => {
    const target = await tree(), unrelated = await tree();
    observed.groups.length = 0; observed.ownerQueryPids.length = 0;
    await cleanObservationGroup(target.root.pid!);
    if (process.platform === 'darwin') expect(observed.groups.every(group => group === target.root.pid)).toBe(true);
    expect(() => process.kill(unrelated.root.pid!, 0)).not.toThrow();
    const pids = [target.root.pid!, ...target.descendants];
    const states = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-o', 'pid=,stat=', '-p', pids.join(',')], (error, stdout, stderr) => {
        if (error && !((error as { code?: number }).code === 1 && !stdout.trim() && !stderr.trim())) reject(error);
        else resolve(stdout);
      });
    });
    expect(states.split('\n').map(line => line.trim()).filter(Boolean)
      .every(line => line.split(/\s+/)[1]?.startsWith('Z'))).toBe(true);
    await expect(cleanObservationGroup(target.root.pid!)).resolves.toBeUndefined();
  });
});
