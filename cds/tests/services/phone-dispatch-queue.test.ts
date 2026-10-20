import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhoneDispatchQueue, type PhoneItem } from '../../src/services/phone-dispatch-queue.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })));
function file() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-queue-')); dirs.push(dir); return path.join(dir, 'state.json'); }
function item(id: string): PhoneItem {
  return { channel: { id: 'channel', name: '手机', kind: 'bark', enabled: true, bark: { key: 'fixture' }, events: ['business-down'], projects: [], createdAt: 0, updatedAt: 0 },
    event: { kind: 'business-down', targetId: id, targetName: id, projectId: 'same-project', detectedAt: '2026-10-15T00:00:00Z', message: 'test', consecutiveFailures: 3 },
    message: { title: id, body: 'test', level: 'active', url: 'https://status.example/?target=' + id }, boardUrl: 'https://status.example/status?target=' + id };
}
describe('手机最终发送出口', () => {
  it('100 个不同故障只发送一个摘要，全部得到回执', async () => {
    const calls: string[] = []; const queue = new PhoneDispatchQueue(file(), async (_, m) => { calls.push(m.title); return { ok: true }; });
    const pending = Array.from({ length: 100 }, (_, n) => queue.enqueue(item(String(n)), 0));
    await queue.flush(29_999); expect(calls).toEqual([]);
    await Promise.all([queue.flush(30_000), queue.flush(30_000)]);
    expect(calls).toEqual(['有 100 项监控变化，请查看']);
    expect((await Promise.all(pending)).every(r => r.ok)).toBe(true);
  });
  it('同项目新增故障仍进入下一条摘要，超过预算保留到窗口释放', async () => {
    const calls: string[] = []; const queue = new PhoneDispatchQueue(file(), async (_, m) => { calls.push(m.title); return { ok: true }; });
    void queue.enqueue(item('one'), 0); await queue.flush(30_000);
    void queue.enqueue(item('two'), 31_000); await queue.flush(90_000);
    const third = queue.enqueue(item('three'), 91_000); await queue.flush(329_999);
    expect(calls).toEqual(['one', 'two']); await queue.flush(330_000);
    expect((await third).ok).toBe(true); expect(calls).toEqual(['one', 'two', 'three']);
  });
  it('发送中断后从磁盘恢复不重发，未发送的新故障不丢', async () => {
    const location = file(); let reserved = '';
    const queue = new PhoneDispatchQueue(location, async () => { reserved = fs.readFileSync(location, 'utf8'); throw Error('timeout'); });
    void queue.enqueue(item('first'), 0); await queue.flush(30_000);
    fs.writeFileSync(location, reserved);
    let calls = 0; const restarted = new PhoneDispatchQueue(location, async () => { calls++; return { ok: true }; });
    expect((await restarted.enqueue(item('first'), 40_000)).ok).toBe(false);
    void restarted.enqueue(item('independent'), 40_000); await restarted.flush(90_000);
    expect(calls).toBe(1);
  });
  it('同一手机多个通道不扩大预算，重复事件不重复发送', async () => {
    let calls = 0; const queue = new PhoneDispatchQueue(file(), async () => { calls++; return { ok: true }; });
    const original = item('same'); const alias = { ...original, channel: { ...original.channel, id: 'alias' } };
    const results = [queue.enqueue(original, 0), queue.enqueue(alias, 0)]; await queue.flush(30_000);
    expect((await Promise.all(results)).every(r => r.ok)).toBe(true); expect(calls).toBe(1);
  });
  it('恢复和演练也共享预算，不开绕行出口', async () => {
    const calls: string[] = []; const queue = new PhoneDispatchQueue(file(), async (_, m) => { calls.push(m.title); return { ok: true }; });
    const recovery = item('恢复'); recovery.event.kind = 'business-recovered'; recovery.message.level = 'passive';
    void queue.enqueue(recovery, 0);
    for (let i = 0; i < 100; i++) { const drill = item('演练-' + i); drill.event.drill = true; void queue.enqueue(drill, 0); }
    await queue.flush(30_000); expect(calls).toEqual(['有 101 项监控变化，请查看']);
  });
});

describe('严重新故障的有界优先通道', () => {
  function urgent(id: string) { const v = item(id); v.event.urgency = 'urgent'; return v; }
  it('普通额度用完后严重新故障立即发送，同项目不同故障最多等待一分钟合并', async () => {
    const calls: string[] = []; const queue = new PhoneDispatchQueue(file(), async (_, m) => { calls.push(m.title); return { ok: true }; });
    void queue.enqueue(item('normal-1'), 0); await queue.flush(30_000);
    void queue.enqueue(item('normal-2'), 31_000); await queue.flush(90_000);
    void queue.enqueue(urgent('severe-1'), 91_000); await queue.flush(91_000);
    expect(calls).toEqual(['normal-1', 'normal-2', 'severe-1']);
    void queue.enqueue(urgent('severe-2'), 92_000); await queue.flush(92_000);
    expect(calls).toHaveLength(3); await queue.flush(151_000); expect(calls.at(-1)).toBe('severe-2');
  });
  it('100 个严重新故障立即合并，随机通知时间及重启不重置故障身份', async () => {
    const location = file(); let calls = 0;
    const sender = async () => { calls++; return { ok: true }; };
    const queue = new PhoneDispatchQueue(location, sender);
    for (let i = 0; i < 100; i++) void queue.enqueue(urgent(String(i)), 0);
    await queue.flush(0); expect(calls).toBe(1);
    const restart = new PhoneDispatchQueue(location, sender);
    const again = urgent('0'); again.event.detectedAt = '2026-10-15T00:01:00Z';
    void restart.enqueue(again, 60_000); await restart.flush(60_000); expect(calls).toBe(1);
    await restart.flush(90_000); expect(calls).toBe(2); // 只能进入普通汇总。
  });
  it('标题和音效不能插队，演练与恢复不能使用严重额度', async () => {
    let calls = 0; const queue = new PhoneDispatchQueue(file(), async () => { calls++; return { ok: true }; });
    const fake = item('严重'); fake.message.level = 'critical'; void queue.enqueue(fake, 0);
    const drill = urgent('drill'); drill.event.drill = true; void queue.enqueue(drill, 0);
    const recovery = urgent('recovery'); recovery.event.kind = 'business-recovered'; void queue.enqueue(recovery, 0);
    await queue.flush(0); expect(calls).toBe(0); await queue.flush(30_000); expect(calls).toBe(1);
  });
  it('普通积压超过分页仍优先严重新故障，连续新身份不能超过每分钟一份严重摘要', async () => {
    const calls: PhoneItem[][] = []; const queue = new PhoneDispatchQueue(file(), async (items) => { calls.push(items); return { ok: true }; });
    for (let i = 0; i < 1200; i++) void queue.enqueue(item('ordinary-' + i), 0);
    for (let t = 0; t < 300_000; t += 5000) {
      void queue.enqueue(urgent('severe-' + t), t); await queue.flush(t);
    }
    expect(calls[0].some(i => i.event.targetId === 'severe-0')).toBe(true);
    expect(calls).toHaveLength(5);
  });
});
