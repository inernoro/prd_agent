import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';

/** 只读取 PID/进程组/状态，不读取命令、环境或共享容器。 */
async function runnableMembers(group: number, exclude?: number): Promise<number[]> {
  if (process.platform === 'linux') {
    const entries = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
    const found: number[] = [];
    // 有界并发读 /proc，避免清理本身制造一个新的文件读取风暴。
    for (let index = 0; index < entries.length; index += 32) {
      await Promise.all(entries.slice(index, index + 32).map(async name => {
        const pid = Number(name);
        if (pid === exclude) return;
        try {
          const stat = await readFile(`/proc/${name}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
          if (Number(fields[2]) === group && fields[0] !== 'Z') found.push(pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }));
    }
    return found;
  }
  if (process.platform !== 'darwin') throw new Error('Observation process groups require Linux or macOS');
  let probePid: number | undefined;
  const stdout = await new Promise<string>((resolve, reject) => {
    const probe = execFile('ps', ['-axo', 'pid=,pgid=,stat='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => error ? reject(error) : resolve(output));
    probePid = probe.pid;
  });
  return stdout.split('\n').flatMap(line => {
    const [pid, pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === group && Number(pid) !== exclude && Number(pid) !== probePid && !state?.startsWith('Z') ? [Number(pid)] : [];
  });
}

/** group 必须来自本次 detached actor 的真实 PID；根进程存活时排除它可清理已结束查询的后代。 */
export async function cleanObservationGroup(group: number, exclude?: number): Promise<void> {
  if (!Number.isSafeInteger(group) || group <= 1 || (exclude !== undefined && exclude !== group)) throw new Error('Invalid observation process group');
  const end = performance.now() + 2000;
  do {
    const members = await runnableMembers(group, exclude);
    if (!members.length) return;
    if (exclude === undefined) {
      try { process.kill(-group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    } else {
      for (const pid of members) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (performance.now() < end);
  throw new Error('Observation process group cleanup unconfirmed');
}

/** 故障时找回尚未登记的启动进程。随机归属标记是独立 argv 字段，绝不按命令片段匹配。 */
export async function findObservationOwners(owner: string): Promise<Array<{ pid: number; group: number }>> {
  if (!/^cds-observation-[a-f0-9]{32}$/.test(owner)) throw new Error('Invalid observation process owner');
  if (process.platform === 'linux') {
    const found: Array<{ pid: number; group: number }> = [];
    for (const name of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      try {
        if (!(await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0').includes(owner)) continue;
        const stat = await readFile(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
        found.push({ pid: Number(name), group: Number(fields[2]) });
      } catch (error) {
        if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      }
    }
    return found;
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,pgid=,args='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => error ? reject(error) : resolve(output));
  });
  return stdout.split('\n').flatMap(line => {
    const fields = line.trim().split(/\s+/);
    return fields.slice(2).includes(owner) ? [{ pid: Number(fields[0]), group: Number(fields[1]) }] : [];
  });
}
