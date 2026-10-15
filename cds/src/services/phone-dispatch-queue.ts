import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AlarmChannelConfig, AlarmEvent, AlarmMessage } from './alarm-route.js';

export interface PhoneItem {
  channel: AlarmChannelConfig; event: AlarmEvent; message: AlarmMessage; boardUrl?: string;
}
interface Result { ok: boolean; reason?: string; status?: number }
interface Pending { item: PhoneItem; at: number }
interface Route { pending: Record<string, Pending>; receipts: Record<string, Result>; attempts: number[] }
/** 单进程 CDS 的手机出口。文件原子保存；重复通道配置按真实接收地址共用预算。 */
export class PhoneDispatchQueue {
  private state: Record<string, Route>;
  private waiters = new Map<string, Array<(r: Result) => void>>();
  private flushing = false;
  constructor(private file: string, private send: (items: PhoneItem[], message: AlarmMessage) => Promise<Result>,
    private delivered: (item: PhoneItem, result: Result) => Promise<void> = async () => {}) {
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.chmodSync(temp, 0o600); fs.renameSync(temp, this.file);
  }
  enqueue(item: PhoneItem, now = Date.now()): Promise<Result> {
    const bark = item.channel.bark!;
    const destination = crypto.createHash('sha256').update(JSON.stringify([(bark.serverUrl || 'https://api.day.app').replace(/\/+$/, ''), bark.key.trim()])).digest('hex');
    const id = crypto.createHash('sha256').update(JSON.stringify([item.event.identity?.subject.id, item.event.projectId, item.event.targetId || item.event.targetName, item.event.kind, item.event.detectedAt])).digest('hex');
    const route = this.state[destination] ??= { pending: {}, receipts: {}, attempts: [] };
    if (route.receipts[id]) return Promise.resolve(route.receipts[id]);
    route.pending[id] ??= { item, at: now };
    this.save();
    return new Promise(resolve => {
      const key = destination + ':' + id;
      this.waiters.set(key, [...(this.waiters.get(key) ?? []), resolve]);
    });
  }
  async flush(now = Date.now()) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [destination, route] of Object.entries(this.state)) {
        route.attempts = route.attempts.filter(at => now - at < 300_000);
        const entries = Object.entries(route.pending).slice(0, 1000);
        if (!entries.length || route.attempts.length >= 2 || now - Math.min(...entries.map(([, p]) => p.at)) < 30_000
          || route.attempts.length && now - route.attempts[route.attempts.length - 1] < 60_000) continue;
        const items = entries.map(([, p]) => p.item).sort((a, b) => Number(a.message.level === 'passive') - Number(b.message.level === 'passive'));
        const message = { ...items[0].message };
        if (items.length > 1) {
          const titles = [...new Set(items.map(i => i.message.title))];
          message.title = `有 ${items.length} 项监控变化，请查看`;
          message.body = titles.slice(0, 3).join('；') + (titles.length > 3 ? `；另有 ${titles.length - 3} 项` : '') + '。各项故障分别保留，点击查看详情。';
          // 直接通道摘要回监控列表；完整原始事件仍在监控及通知台账中。
          if (items[0].boardUrl) {
            const url = new URL(items[0].boardUrl); url.search = ''; url.hash = ''; message.url = url.toString();
          }
        }
        const unknown = { ok: false, reason: '发送结果待核实，未自动重发' };
        route.attempts.push(now);
        for (const [id] of entries) { route.receipts[id] = unknown; delete route.pending[id]; }
        this.save();
        let result: Result;
        try { result = await this.send(items, message); } catch { result = unknown; }
        for (const [id, pending] of entries) {
          route.receipts[id] = result;
          const key = destination + ':' + id;
          for (const resolve of this.waiters.get(key) ?? []) resolve(result);
          this.waiters.delete(key);
          await this.delivered(pending.item, result);
        }
        this.save();
      }
    } finally { this.flushing = false; }
  }
}
