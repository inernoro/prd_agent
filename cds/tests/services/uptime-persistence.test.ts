import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UptimeMonitorService, type UptimeMonitorConfig } from '../../src/services/uptime-monitor.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(count = 40) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-uptime-write-')); dirs.push(dir);
  const fp = path.join(dir, 'history.json');
  const targets = Array.from({ length: count }, (_, i) => ({
    id: `b${i}::api`, source: 'branch', name: `b${i}`, status: 'up', firstSeenAt: 1,
    samples: Array.from({ length: 1000 }, (_, j) => ({ t: j, up: true, ms: 3, err: '诊断历史'.repeat(20) })),
    daily: [], incidents: [],
  }));
  fs.writeFileSync(fp, JSON.stringify({ version: 1, savedAt: 1, targets }));
  const warn = vi.fn();
  const config: UptimeMonitorConfig = { enabled: true, intervalMs: 60000, timeoutMs: 5000,
    failureThreshold: 3, recoveryThreshold: 1, maxSamples: 1440, excludePatterns: [], scope: 'all', storePath: fp };
  const monitor = new UptimeMonitorService({ state: { getAllBranches: () => [] }, config, logger: { warn } });
  return { monitor, fp, warn, config };
}

describe('存活历史异步持久化', () => {
  it('大历史分段序列化并让出事件循环，关键flush后能按原v1格式冷读', async () => {
    const { monitor, fp, config } = fixture();
    let wholeSnapshots = 0;
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      if (value?.version === 1 && Array.isArray(value?.targets)) wholeSnapshots++;
      return stringify(value, ...args);
    });
    let yielded = false;
    monitor.forgetTarget('b0::api');
    setImmediate(() => { yielded = true; });
    await monitor.flush();
    expect(yielded).toBe(true);
    expect(wholeSnapshots).toBe(0);
    const stored = JSON.parse(fs.readFileSync(fp, 'utf8'));
    expect(stored.version).toBe(1);
    expect(stored.targets).toHaveLength(39);
    expect(stored.targets[0].samples).toHaveLength(1000);
    const reopened = new UptimeMonitorService({ state: { getAllBranches: () => [] }, config });
    expect(reopened.getRecord('b0::api')).toBeUndefined();
    expect(reopened.getRecord('b1::api')?.samples).toHaveLength(1000);
    expect(stored.targets.every((t: { id: string }) => t.id !== 'b0::api')).toBe(true);
    await reopened.stop(); await monitor.stop();
  });

  it('在途写入后又删除目标，flush必须等待最新台账，不能让旧快照最后覆盖', async () => {
    const { monitor, fp } = fixture(3);
    const rename = fs.promises.rename.bind(fs.promises);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(r => { release = r; });
    const reached = new Promise<void>(r => { entered = r; });
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => { entered(); await blocked; return rename(from, to); });
    monitor.forgetTarget('b0::api');
    await reached;
    monitor.forgetTarget('b1::api');
    const flushed = monitor.flush(); release(); await flushed;
    expect(JSON.parse(fs.readFileSync(fp, 'utf8')).targets.map((t: { id: string }) => t.id)).toEqual(['b2::api']);
    await monitor.stop();
  });

  it('原子替换失败保留原历史、flush明确失败；恢复后重试保留最新结果并清临时文件', async () => {
    const { monitor, fp, warn } = fixture(2);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('owned disk write failed'));
    monitor.forgetTarget('b0::api');
    await expect(monitor.flush()).rejects.toThrow('owned disk write failed');
    expect(JSON.parse(fs.readFileSync(fp, 'utf8')).targets).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
    await monitor.flush();
    expect(JSON.parse(fs.readFileSync(fp, 'utf8')).targets).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(fp))).toEqual(['history.json']);
    await monitor.stop();
  });

  it('停机先等在途真实探测并保存最后样本，同时拒绝新探测', async () => {
    const { fp, config } = fixture(0);
    let release!: () => void;
    const pending = new Promise<{ up: boolean; ms: number; code: number }>(r => { release = () => r({ up: true, ms: 7, code: 200 }); });
    const probe = vi.fn(() => pending);
    const monitor = new UptimeMonitorService({
      state: { getAllBranches: () => [{ id: 'branch', projectId: 'p', branch: 'feature', status: 'running',
        services: { api: { profileId: 'api', containerName: 'owned-api', hostPort: 10001, status: 'running' } } } as never] },
      config, probe,
    });
    const cycle = monitor.runCycle();
    const stopped = monitor.stop();
    expect(await monitor.probeNow('branch::api')).toMatchObject({ ok: false });
    await monitor.runCycle();
    release(); await cycle; await stopped;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(fp, 'utf8')).targets[0].samples).toMatchObject([{ up: true, ms: 7, code: 200 }]);
  });
});
