/** 独立通知所有者：主站只保存待投递事件，接收端回执才算投递成功。
 * 配置含接收端公钥；通道凭据只出现在加密信封中，不开放明文读取接口。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Router } from 'express';
import { assertUnscopedAdmin } from './unscoped-admin-guard.js';
import { independentIncidentUrl } from './alarm-dispatch.js';
import { renderAlarmMessage, type AlarmChannelConfig, type AlarmEvent } from './alarm-route.js';

interface Item { id: string; channelId: string; event: AlarmEvent; boardUrl?: string; at: number }
interface RelayState { enabled: boolean; publicKey: string; channelIds: string[]; challenge: string; readyAt: number; queue: Item[] }
export class AlarmRelay {
  private state: RelayState;
  constructor(private file: string) {
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { enabled: false, publicKey: '', channelIds: [], challenge: '', readyAt: 0, queue: [] };
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, this.file);
  }
  status() { return { enabled: this.state.enabled, channelIds: this.state.channelIds, pending: this.state.queue.length,
    readyAt: this.state.readyAt, receiverHealthy: Date.now() - this.state.readyAt < 180_000,
    fingerprint: this.state.publicKey ? crypto.createHash('sha256').update(this.state.publicKey).digest('hex') : null }; }
  configure(publicKey: string, channelIds: string[]) {
    if (this.state.enabled || this.state.queue.length) throw new Error('先完成待投递事件并停用外部所有者，才能更换接收端');
    const key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error('需要至少 2048 位 RSA 公钥');
    if (!channelIds.length) throw new Error('请选择通知通道');
    this.state = { ...this.state, publicKey, channelIds, challenge: crypto.randomBytes(32).toString('hex'), readyAt: 0 }; this.save();
  }
  activate(enabled: boolean) {
    if (enabled && (!this.state.readyAt || Date.now() - this.state.readyAt > 180_000)) throw new Error('接收端尚未解密并确认就绪');
    if (!enabled && this.state.queue.length) throw new Error('待投递事件尚未完成，不可切回两个发送者');
    this.state.enabled = enabled; this.save();
  }
  owns(channelId: string) { return this.state.enabled && this.state.channelIds.includes(channelId); }
  enqueue(channelId: string, event: AlarmEvent, boardUrl?: string) {
    const id = crypto.createHash('sha256').update(JSON.stringify([channelId, event.targetId, event.kind, event.detectedAt])).digest('hex');
    if (!this.state.queue.some(i => i.id === id)) {
      this.state.queue.push({ id, channelId, event, boardUrl, at: Date.now() }); this.save();
    }
    return id;
  }
  confirm(proof: string) {
    if (!proof || proof !== this.state.challenge) throw new Error('接收端确认无效');
    this.state.readyAt = Date.now(); this.save();
  }
  getItem(id: string) { return this.state.queue.find(i => i.id === id); }
  unavailableItems(channels: AlarmChannelConfig[]) {
    const available = new Set(channels.filter(c => c.enabled && c.kind === 'bark').map(c => c.id));
    return this.state.queue.filter(item => !available.has(item.channelId));
  }
  acknowledge(id: string): Item | undefined {
    const item = this.state.queue.find(i => i.id === id);
    this.state.queue = this.state.queue.filter(i => i.id !== id); this.save(); return item;
  }
  envelope(channels: AlarmChannelConfig[]) {
    if (!this.state.publicKey) throw new Error('尚未登记接收端');
    const selected = channels.filter(c => c.enabled && c.kind === 'bark' && this.state.channelIds.includes(c.id));
    const payload = { enabled: this.state.enabled, challenge: this.state.challenge, channels: selected,
      items: this.state.enabled ? this.state.queue.slice(0, 100).map(i => {
        const channel = selected.find(c => c.id === i.channelId);
        const url = channel ? independentIncidentUrl(channel, i.event, i.boardUrl) || i.boardUrl : i.boardUrl;
        return { ...i, message: renderAlarmMessage(i.event, { boardUrl: url }) };
      }) : [] };
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    return { key: crypto.publicEncrypt({ key: this.state.publicKey, oaepHash: 'sha256' }, key).toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
}

export function registerAlarmRelayRoutes(router: Router, relay: AlarmRelay, deps: {
  channels: () => AlarmChannelConfig[];
  acknowledged: (item: Item, result: { ok: boolean; reason?: string; merged?: boolean }) => Promise<void>;
}) {
  const retireUnavailable = async () => {
    for (const item of relay.unavailableItems(deps.channels())) {
      // 先处理取消记录，再移出主站队列；不再交给接收端，也不能把取消当成送达。
      try {
        await deps.acknowledged(item, { ok: false, reason: '通知通道已停用或删除，本次投递已取消' });
      } catch { throw new Error('未能保存取消记录，请稍后重试'); }
      relay.acknowledge(item.id);
    }
  };
  router.use('/cds-system/alarm-relay', (req, res, next) => {
    const denied = assertUnscopedAdmin(req as Parameters<typeof assertUnscopedAdmin>[0]);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  router.get('/cds-system/alarm-relay', (_req, res) => res.json(relay.status()));
  router.put('/cds-system/alarm-relay', async (req, res) => {
    try {
      if (req.body.enabled === false) await retireUnavailable();
      if (req.body.publicKey) {
        const ids = req.body.channelIds;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => !deps.channels().some(c => c.id === id && c.kind === 'bark'))) throw new Error('仅支持现有 Bark 通道');
        relay.configure(String(req.body.publicKey), ids);
      }
      if (typeof req.body.enabled === 'boolean') relay.activate(req.body.enabled);
      res.json(relay.status());
    } catch (err) { res.status(400).json({ message: (err as Error).message }); }
  });
  router.post('/cds-system/alarm-relay/poll', async (req, res) => {
    try {
      if (req.body.proof) {
        relay.confirm(String(req.body.proof));
        for (const ack of (Array.isArray(req.body.acks) ? req.body.acks.slice(0, 100) : [])) {
          if (typeof ack.id !== 'string' || typeof ack.ok !== 'boolean') continue;
          const item = relay.getItem(ack.id);
          if (item) await deps.acknowledged(item, { ok: ack.ok, merged: ack.merged === true, reason: ack.ok ? undefined : '外部通知未确认送达，请查看独立监控的投递记录' });
          relay.acknowledge(ack.id);
        }
      }
      await retireUnavailable();
      res.json(relay.envelope(deps.channels()));
    } catch { res.status(400).json({ message: '外部通知同步失败，请检查接收端配置与回执' }); }
  });
}
