import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { IShellExecutor, ExecResult } from '../types.js';
import { shellQuoteArg } from './secure-database-cli.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export const CORE_IMAGE_CACHE_IDLE_MS = 120_000;
const MAX_RECORDS = 2, MAX_BYTES = 16 * 1024 ** 3, MAX_RECEIPT_BYTES = 8192;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
interface RecordEntry { id: string; imageId: string; size: number; expiresAt: number; issued: boolean; confirmed: boolean; reclaiming: boolean; }
interface Receipt { schema: 1; instanceId: string; daemonId: string; entries: RecordEntry[]; }

/** A private, finite cache reference keeps digest-only runtime images out of
 * dangling-image prune. It never disables reclaim or removes by content ID. */
export class CoreImageCache {
  private readonly receiptFile: string;
  private readonly repository: string;
  private receipt?: Receipt;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly users = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly shell: IShellExecutor, private readonly root: string,
    private readonly instanceId: string, private readonly canReclaim: () => boolean = () => true,
    private readonly events?: ServerEventLogSink | null) {
    this.receiptFile = path.join(root, 'cache.json');
    this.repository = `cds-core-cache-${crypto.createHash('sha256').update(instanceId).digest('hex').slice(0, 16)}`;
  }

  async resume(): Promise<void> { await this.exclusive(async () => { await this.load(); this.schedule(); }); }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }

  async acquire(imageId: string, signal: AbortSignal): Promise<() => void> {
    if (!IMAGE_ID.test(imageId)) throw new Error('Core image content identity is unconfirmed');
    const deadline = Date.now() + 5000;
    let timer: NodeJS.Timeout | undefined;
    const task = this.exclusive(async () => {
      this.assertOpen(signal, deadline); await this.load(); this.assertOpen(signal, deadline);
      const daemonId = await this.daemon(deadline, signal);
      if (this.receipt && this.receipt.daemonId !== daemonId) throw new Error('Core image cache daemon ownership changed');
      const view = await this.exec(['image', 'inspect', imageId, '--format', '{{.Id}} {{.Size}}'], deadline, signal);
      const match = /^((?:sha256:)[a-f0-9]{64}) ([0-9]+)$/.exec(view.stdout.trim());
      if (view.exitCode !== 0 || !match || match[1] !== imageId || !Number.isSafeInteger(Number(match[2])))
        throw new Error('Core image metadata is unconfirmed');
      this.receipt ??= { schema: 1, instanceId: this.instanceId, daemonId, entries: [] };
      let record = this.receipt.entries.find(x => x.imageId === imageId);
      if (!record) {
        const size = Number(match[2]);
        if (this.receipt.entries.length >= MAX_RECORDS || size + this.receipt.entries.reduce((sum, x) => sum + x.size, 0) > MAX_BYTES)
          throw new Error('Core image cache budget is exhausted');
        record = { id: crypto.randomUUID().replace(/-/g, ''), imageId, size, expiresAt: Date.now() + CORE_IMAGE_CACHE_IDLE_MS,
          issued: false, confirmed: false, reclaiming: false };
        this.receipt.entries.push(record);
        await this.persist(); // Record intended ownership before the tag mutation.
      }
      if (record.reclaiming) throw new Error('Core image cache release is still unconfirmed');
      const tag = this.tag(record);
      const current = await this.exec(['image', 'inspect', tag, '--format', '{{.Id}}'], deadline, signal);
      if (current.exitCode === 0 && (!record.issued || current.stdout.trim() !== imageId)) throw new Error('Core image cache reference ownership changed');
      if (current.exitCode !== 0 && !this.absent(current)) throw new Error('Core image cache reference could not be inspected');
      if (current.exitCode !== 0) {
        if (record.issued && !record.confirmed) throw new Error('Core image cache acquisition is still unconfirmed');
        record.issued = true; record.confirmed = false; await this.persist();
        const tagged = await this.exec(['image', 'tag', imageId, tag], deadline, signal);
        if (tagged.exitCode !== 0) throw new Error('Core image cache reference could not be established');
        const confirmed = await this.exec(['image', 'inspect', tag, '--format', '{{.Id}}'], deadline, signal);
        if (confirmed.exitCode !== 0 || confirmed.stdout.trim() !== imageId) throw new Error('Core image cache reference is unconfirmed');
      }
      record.confirmed = true; record.expiresAt = Date.now() + CORE_IMAGE_CACHE_IDLE_MS;
      await this.persist(); this.assertOpen(signal, deadline);
      this.users.set(record.id, (this.users.get(record.id) ?? 0) + 1); this.record('acquired', record);
      this.schedule(); let released = false;
      return () => {
        if (released) return; released = true;
        const count = (this.users.get(record!.id) ?? 1) - 1;
        if (count) this.users.set(record!.id, count); else this.users.delete(record!.id);
        this.record('released', record!); this.schedule(true);
      };
    }).finally(() => this.schedule());
    try {
      return await Promise.race([task, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Core image cache acquisition deadline exceeded')), Math.max(1, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  }

  async reclaimExpired(): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      if (!this.receipt || !this.canReclaim()) return;
      const expired = this.receipt.entries.filter(x => x.expiresAt <= Date.now() && !this.users.has(x.id));
      if (!expired.length) return;
      const deadline = Date.now() + 120_000;
      if (await this.daemon(deadline) !== this.receipt.daemonId) throw new Error('Core image cache daemon ownership changed');
      for (const record of expired) {
        const tag = this.tag(record), view = await this.exec(['image', 'inspect', tag, '--format', '{{.Id}}'], deadline);
        if (view.exitCode === 0 && view.stdout.trim() !== record.imageId) throw new Error('Core image cache reference ownership changed');
        if (view.exitCode !== 0 && !this.absent(view)) throw new Error('Core image cache reference could not be inspected');
        if (view.exitCode !== 0 && record.issued && !record.confirmed && !record.reclaiming)
          throw new Error('Core image cache acquisition is still unconfirmed');
        if (view.exitCode === 0) {
          if (!record.issued) throw new Error('Core image cache reference ownership is unconfirmed');
          record.confirmed = true; record.reclaiming = true; await this.persist();
          const removed = await this.exec(['image', 'rm', '--no-prune', tag], deadline);
          if (removed.exitCode !== 0 && !this.absent(removed)) throw new Error('Core image cache release is unconfirmed');
          const after = await this.exec(['image', 'inspect', tag, '--format', '{{.Id}}'], deadline);
          if (after.exitCode === 0 || !this.absent(after)) throw new Error('Core image cache release is unconfirmed');
        }
        this.receipt.entries = this.receipt.entries.filter(x => x.id !== record.id);
        await this.persist(); this.record('reclaimed', record);
      }
    });
  }

  private tag(record: RecordEntry): string { return `${this.repository}:${record.id}`; }
  private absent(result: ExecResult): boolean { return result.exitCode !== 0 && /No such (?:image|object)/i.test(`${result.stderr}\n${result.stdout}`); }
  private assertOpen(signal: AbortSignal, deadline: number): void {
    if (signal.aborted || this.stopped || Date.now() >= deadline) throw new Error('Core image cache acquisition cancelled or expired');
  }
  private async daemon(deadline: number, signal?: AbortSignal): Promise<string> {
    const result = await this.exec(['info', '--format', '{{.ID}}'], deadline, signal);
    const id = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(id)) throw new Error('Core image cache daemon identity is unconfirmed');
    return id;
  }
  private async exec(args: string[], deadline: number, signal?: AbortSignal): Promise<ExecResult> {
    const remaining = deadline - Date.now(); if (remaining <= 0 || signal?.aborted) throw new Error('Core image cache command expired');
    const reading = ['info', 'inspect'].includes(args[0]) || args[1] === 'inspect';
    return this.shell.exec(['docker', ...args].map(shellQuoteArg).join(' '), {
      timeout: remaining, signal, executionLane: reading ? 'observation' : 'operation',
      beforeStart: () => { if (Date.now() >= deadline || signal?.aborted) throw new Error('Core image cache command expired'); },
    });
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work); this.queue = task.catch(() => undefined); return task;
  }
  private async load(): Promise<void> {
    if (this.receipt) return;
    let handle;
    try { handle = await fs.open(this.receiptFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECEIPT_BYTES || (process.platform !== 'win32'
        && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new Error('Core image cache receipt is unconfirmed');
      const data = Buffer.alloc(MAX_RECEIPT_BYTES + 1), read = await handle.read(data, 0, data.length, 0);
      if (read.bytesRead > MAX_RECEIPT_BYTES) throw new Error('Core image cache receipt is oversized');
      const raw = JSON.parse(data.subarray(0, read.bytesRead).toString('utf8')) as Receipt;
      if (raw.schema !== 1 || raw.instanceId !== this.instanceId || !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(raw.daemonId)
        || !Array.isArray(raw.entries) || raw.entries.length > MAX_RECORDS) throw new Error('Core image cache receipt ownership is unconfirmed');
      const ids = new Set<string>(), images = new Set<string>(); let bytes = 0;
      for (const entry of raw.entries) {
        if (!/^[a-f0-9]{32}$/.test(entry.id) || !IMAGE_ID.test(entry.imageId) || !Number.isSafeInteger(entry.size) || entry.size < 0
          || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0 || entry.expiresAt > Date.now() + CORE_IMAGE_CACHE_IDLE_MS + 60_000
          || ['issued', 'confirmed', 'reclaiming'].some(key => typeof entry[key as keyof RecordEntry] !== 'boolean')
          || (entry.confirmed && !entry.issued) || (entry.reclaiming && !entry.confirmed) || ids.has(entry.id) || images.has(entry.imageId))
          throw new Error('Core image cache receipt is unconfirmed');
        ids.add(entry.id); images.add(entry.imageId); bytes += entry.size;
      }
      if (bytes > MAX_BYTES) throw new Error('Core image cache receipt exceeds budget');
      this.receipt = raw;
    } finally { await handle.close(); }
  }
  private async persist(): Promise<void> {
    if (!this.receipt?.entries.length) {
      await fs.rm(this.receiptFile, { force: true });
      try { await fs.rmdir(this.root); } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      this.receipt = undefined; return;
    }
    const data = JSON.stringify(this.receipt); if (Buffer.byteLength(data) > MAX_RECEIPT_BYTES) throw new Error('Core image cache receipt is oversized');
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, `.cache-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.receiptFile);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  private schedule(released = false): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.stopped || !this.receipt?.entries.length) return;
    const next = Math.min(...this.receipt.entries.map(x => x.expiresAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reclaimExpired().catch(() => this.record('unconfirmed')).finally(() => this.schedule());
    }, next <= Date.now() ? (released ? 1000 : 60_000) : Math.max(1000, Math.min(60_000, next - Date.now())));
    this.timer.unref();
  }
  private record(action: string, entry?: RecordEntry): void {
    try { this.events?.record({ category: 'container', severity: action === 'unconfirmed' ? 'warn' : 'info',
      source: 'core-image-cache', action: `agent.core-image-cache.${action}`, operationId: entry?.id ?? null,
      details: { instanceId: this.instanceId, imageId: entry?.imageId ?? null, cacheReference: entry ? this.tag(entry) : null,
        expiresAt: entry?.expiresAt ?? null, bytes: entry?.size ?? null } }); }
    catch { console.warn('[core-image-cache] 缓存事件记录未确认。'); }
  }
}
