import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoticeLedgerService, renderNoticeFromEvent } from '../../src/services/notice-ledger.js';
import { buildMapNotificationBody } from '../../src/services/notice-outbound-map.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('capacity notices lead to the existing disk governance tab', () => {
  it.each(['capacity.risk', 'capacity.recovered'] as const)('%s preserves the actionable destination through persistence and MAP mapping', (type) => {
    const input = renderNoticeFromEvent({ type, ts: new Date().toISOString(), data: { targetId: 'janitor', message: 'Private link regression' } });
    expect(input?.href, 'default settings opens CDS update, not disk governance').toBe('/cds-settings#scheduler');
    expect(input?.actionLabel).toBe('查看容量治理');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-notice-link-')); roots.push(root);
    const storePath = path.join(root, 'notices.json');
    const ledger = new NoticeLedgerService({ storePath });
    ledger.upsert(input!);
    const reloaded = new NoticeLedgerService({ storePath }).list()[0];
    expect(reloaded.href).toBe('/cds-settings#scheduler');
    const outbound = buildMapNotificationBody(reloaded, { baseUrl: 'https://map.example.invalid', token: 'private-fixture', source: 'system-alert', publicOrigin: 'https://cds.example.invalid' });
    expect(outbound.actionUrl).toBe('https://cds.example.invalid/cds-settings#scheduler');
    expect(outbound.actionLabel).toBe('查看容量治理');
  });

  it('self-update failures retain the maintenance destination', () => {
    const input = renderNoticeFromEvent({ type: 'self.update.failed', ts: new Date().toISOString(), data: { message: 'Private compatibility regression' } });
    expect(input?.href).toBe('/cds-settings');
    expect(input?.actionLabel).toBe('查看维护面板');
  });
});
