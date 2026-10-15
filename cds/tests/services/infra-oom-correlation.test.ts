import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfraLifecycleWatcher, setReplicaMemberDeathListener } from '../../src/services/infra-lifecycle-watcher.js';
function fixture() {
  const records: any[] = []; const watcher = new InfraLifecycleWatcher({ serverEventLogStore: { record: row => records.push(row) } });
  const send = (event: string, id: string | undefined, name = 'cds-infra-owned', time = 100) => (watcher as unknown as { ingest(line: string): void }).ingest(JSON.stringify({ Action: event, time, Actor: { ...(id === undefined ? {} : { ID: id }), Attributes: { name, exitCode: '137' } } }));
  const recent = () => (watcher as unknown as { recentOom: Map<string, number> }).recentOom.size;
  return { watcher, records, send, recent, last: () => records.filter(r => r.action === 'infra.lifecycle.die').at(-1)?.message as string };
}
afterEach(() => setReplicaMemberDeathListener(null));
describe('OOM关联的容量与证据', () => {
  it('同10秒内600个OOM严格受400条容量约束，事件环不能代替关联表上限', () => {
    const f = fixture(); for (let i = 0; i < 600; i++) f.send('oom', 'owned-' + i, 'cds-infra-owned-' + i);
    expect(f.watcher.getEvents()).toHaveLength(400); expect(f.recent()).toBeLessThanOrEqual(400);
  });
  it('同名不同容器ID的137不继承旧容器OOM证据', () => {
    const f = fixture(); f.send('oom', 'old-id'); f.send('die', 'new-id', undefined, 101);
    expect(f.last()).toContain('原因待核实'); expect(f.last()).not.toContain('cgroup OOM kill');
  });
  it.each(['start', 'restart'])('%s标记新的进程代次，旧OOM不能跨启动归因', event => {
    const f = fixture(); f.send('oom', 'owned-id'); f.send(event, 'owned-id', undefined, 101); f.send('die', 'owned-id', undefined, 102);
    expect(f.last()).toContain('原因待核实'); expect(f.last()).not.toContain('cgroup OOM kill');
  });
  it('缺少实际容器ID，名字相同不能证明关联', () => {
    const f = fixture(); f.send('oom', undefined); f.send('die', undefined, undefined, 101);
    expect(f.last()).toContain('原因待核实'); expect(f.last()).not.toContain('cgroup OOM kill');
  });
  it('被容量淘汰的关联保持未知，保留的同ID证据仍能确认', () => {
    const f = fixture(); for (let i = 0; i < 401; i++) f.send('oom', 'owned-' + i, 'cds-infra-owned-' + i);
    f.send('die', 'owned-0', 'cds-infra-owned-0', 101); expect(f.last()).toContain('原因待核实');
    f.send('die', 'owned-400', 'cds-infra-owned-400', 101); expect(f.last()).toContain('cgroup OOM kill');
  });
  it('更新证据保留最近的ID，过期或淘汰均不宣称已确定外部SIGKILL', () => {
    const f = fixture(); for (let i = 0; i < 400; i++) f.send('oom', 'owned-' + i, 'cds-infra-owned-' + i);
    f.send('oom', 'owned-0', 'cds-infra-owned-0', 102); f.send('oom', 'extra', 'cds-infra-extra', 102);
    f.send('die', 'owned-0', 'cds-infra-owned-0', 103); expect(f.last()).toContain('cgroup OOM kill');
    f.send('die', 'owned-1', 'cds-infra-owned-1', 103); expect(f.last()).toContain('原因待核实');
  });
  it('超出10秒的137原因未知，同时仍通知真实死亡摘流', () => {
    const f = fixture(); const death = vi.fn(); setReplicaMemberDeathListener(death);
    f.send('oom', 'owned-id', 'cds-owned-web-res-1'); f.send('die', 'owned-id', 'cds-owned-web-res-1', 111);
    expect(f.last()).toContain('原因待核实'); expect(death).toHaveBeenCalledWith('cds-owned-web-res-1', expect.stringContaining('原因待核实'));
  });
  it('同实际容器ID、同一进程代次的OOM/die保留确认和死亡通知', () => {
    const f = fixture(); const death = vi.fn(); setReplicaMemberDeathListener(death);
    f.send('oom', 'owned-id', 'cds-owned-web-res-1'); f.send('die', 'owned-id', 'cds-owned-web-res-1', 101);
    expect(f.last()).toContain('cgroup OOM kill'); expect(death).toHaveBeenCalledOnce(); expect(f.recent()).toBe(0);
  });
  it('旧事件协议的实际id仍能关联并留在取证详情中', () => {
    const f = fixture();
    const ingest = (event: string) => (f.watcher as unknown as { ingest(line: string): void }).ingest(JSON.stringify({ status: event, id: 'legacy-owned', time: 100, Actor: { Attributes: { name: 'cds-infra-owned', exitCode: '137' } } }));
    ingest('oom'); ingest('die');
    expect(f.last()).toContain('cgroup OOM kill');
    expect(f.watcher.getEvents()[0].containerId).toBe('legacy-owned');
  });
  it('超额UTF8身份不保留、不退化为名称关联', () => {
    const f = fixture(); const oversized = '界'.repeat(43);
    f.send('oom', oversized); f.send('die', oversized);
    expect(f.recent()).toBe(0); expect(f.last()).toContain('原因待核实');
    expect(f.watcher.getEvents()[0].containerId).toBeUndefined();
  });
  it('倒序死亡事件不使用未来OOM，死亡后清除当前身份', () => {
    const f = fixture(); f.send('oom', 'owned-id', undefined, 102); f.send('die', 'owned-id', undefined, 101);
    expect(f.last()).toContain('原因待核实'); expect(f.recent()).toBe(0);
  });
  it('监听已启动时重复start不丢弃连续OOM事实', () => {
    const f = fixture(); f.watcher.start(); f.send('oom', 'owned-id'); f.watcher.start(); f.send('die', 'owned-id', undefined, 101);
    expect(f.last()).toContain('cgroup OOM kill');
  });
  it('停止撤销关联但保留历史事件取证', async () => {
    const f = fixture(); f.send('oom', 'owned-id'); await f.watcher.stop();
    expect(f.recent()).toBe(0); expect(f.watcher.getEvents()).toHaveLength(1);
    f.send('die', 'owned-id', undefined, 101); expect(f.last()).toContain('原因待核实');
  });
});
