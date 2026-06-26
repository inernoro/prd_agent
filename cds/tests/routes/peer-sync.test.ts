/**
 * WS3 MAP-KBTP peer-sync 端点自测（CDS 源 peer）。
 *
 * 在最小 Express app 上挂载 peer-sync 路由，按协议构造 HMAC 签名，走通
 * handshake → ping → capabilities → signature → export 全链，断言：
 *   - handshake 用配对码换发 sharedSecret + selfNodeId；
 *   - 签名正确的请求 200，签名错误 / 过期时间戳 401；
 *   - export 返回合法 SyncResourceBundle（resourceType=document-store，
 *     records 含报告 content + contentHash）。
 * 这是不依赖 MAP 的最强自测（协议互通性的 CDS 侧契约）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { StateService } from '../../src/services/state.js';
import { createPeerSyncRouter, createPeerSyncAdminRouter } from '../../src/routes/peer-sync.js';

function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
          catch { resolve({ status: res.statusCode!, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 复刻 MAP 侧签名（SSOT = prd-api PeerNodeService.Compute）：
 * `${METHOD}\n${path}\n${ts}\n${sha256(body)}`，HMAC-SHA256(base64decode(secret))。
 * 注意：空 body 也走 sha256("")=e3b0c4…（不是空串），与 MAP 一致。
 */
function sign(secret: string, method: string, urlPath: string, body: string): { ts: string; sig: string } {
  const ts = String(Date.now());
  const bodyHash = crypto.createHash('sha256').update(body ?? '', 'utf8').digest('hex');
  const payload = `${method.toUpperCase()}\n${urlPath}\n${ts}\n${bodyHash}`;
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(payload, 'utf8').digest('hex');
  return { ts, sig };
}

function hdr(nodeId: string, ts: string, sig: string): Record<string, string> {
  return { 'X-Peer-Node': nodeId, 'X-Peer-Ts': ts, 'X-Peer-Sign': sig };
}

describe('peer-sync MAP-KBTP endpoints', () => {
  let stateFile: string;
  let service: StateService;
  let server: http.Server;
  const initiatorNodeId = 'mapnode' + 'a'.repeat(20);

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-peersync-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    service = new StateService(stateFile);
    service.load();
    // 造一个项目 + 一份报告（export 才有数据）。
    service.addProject({ id: 'proj-1', slug: 'proj-1', name: '项目一' } as never);
    service.createAcceptanceReport({
      title: '登录页验收', format: 'md', content: '# 登录页\n\n通过', projectId: 'proj-1',
      verdict: 'pass', tier: 'L2', commitSha: 'abc1234',
    });

    const app = express();
    // 镜像生产：全局 JSON 解析器 + verify 钩子把原字节存到 req.rawBody（HMAC 用）。
    app.use(express.json({ verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
    app.use('/api/peer-sync', createPeerSyncRouter({ stateService: service }));
    app.use('/api/peer-sync', createPeerSyncAdminRouter({ stateService: service }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  afterEach(async () => {
    delete process.env.CDS_CACHE_BASE;
    await new Promise<void>((r) => server.close(() => r()));
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  async function pairAndGetSecret(): Promise<{ secret: string; selfNodeId: string }> {
    const { code } = service.createPeerPairingCode('test-map');
    const hs = await request(server, 'POST', '/api/peer-sync/handshake', JSON.stringify({
      pairingCode: code, initiatorNodeId, initiatorBaseUrl: 'https://map.example.com',
    }));
    expect(hs.status).toBe(200);
    expect(hs.body.success).toBe(true);
    expect(hs.body.data.sharedSecret).toBeTruthy();
    expect(hs.body.data.nodeId).toMatch(/^[0-9a-f]{32}$/);
    return { secret: hs.body.data.sharedSecret, selfNodeId: hs.body.data.nodeId };
  }

  it('handshake exchanges a shared secret and rejects reused/invalid codes', async () => {
    const { code } = service.createPeerPairingCode();
    const first = await request(server, 'POST', '/api/peer-sync/handshake', JSON.stringify({ pairingCode: code, initiatorNodeId }));
    expect(first.status).toBe(200);
    // Reuse → 401.
    const reuse = await request(server, 'POST', '/api/peer-sync/handshake', JSON.stringify({ pairingCode: code, initiatorNodeId }));
    expect(reuse.status).toBe(401);
    // Bogus code → 401.
    const bogus = await request(server, 'POST', '/api/peer-sync/handshake', JSON.stringify({ pairingCode: 'nope', initiatorNodeId }));
    expect(bogus.status).toBe(401);
  });

  it('handshake/confirm + finalize return 404 so MAP treats CDS as a legacy single-phase peer', async () => {
    const { code } = service.createPeerPairingCode();
    const hs = await request(server, 'POST', '/api/peer-sync/handshake', JSON.stringify({ pairingCode: code, initiatorNodeId }));
    expect(hs.status).toBe(200);
    // MAP 发起方握手后会 POST confirm；CDS 单阶段 → 必须 404（不是登录网关 401），
    // 否则 MAP 的 legacyPeerCommittedOnHandshake 判定失效会取消配对。
    const confirm = await request(server, 'POST', '/api/peer-sync/handshake/confirm', JSON.stringify({ pairingCode: code, initiatorNodeId, sharedSecret: 'x' }));
    expect(confirm.status).toBe(404);
    const finalize = await request(server, 'POST', '/api/peer-sync/handshake/finalize', JSON.stringify({ pairingCode: code, initiatorNodeId }));
    expect(finalize.status).toBe(404);
    // cancel 现在要求 HMAC 签名（防任何人凭 node id 撤销别人的配对，Codex P2）。
    const secret = hs.body.data.sharedSecret as string;
    const cbody = JSON.stringify({ initiatorNodeId });
    // 未签名 → 401（不再裸删）。
    const unsigned = await request(server, 'POST', '/api/peer-sync/handshake/cancel', cbody);
    expect(unsigned.status).toBe(401);
    // 用节点 sharedSecret 正确签名 → 200，删除该节点。
    const c = sign(secret, 'POST', '/api/peer-sync/handshake/cancel', cbody);
    const cancel = await request(server, 'POST', '/api/peer-sync/handshake/cancel', cbody, hdr(initiatorNodeId, c.ts, c.sig));
    expect(cancel.status).toBe(200);
  });

  it('ping + capabilities succeed with a valid signature', async () => {
    const { secret } = await pairAndGetSecret();
    const p = sign(secret, 'GET', '/api/peer-sync/ping', '');
    const ping = await request(server, 'GET', '/api/peer-sync/ping', '', hdr(initiatorNodeId, p.ts, p.sig));
    expect(ping.status).toBe(200);
    expect(ping.body.data.ok).toBe(true);

    const c = sign(secret, 'GET', '/api/peer-sync/capabilities', '');
    const cap = await request(server, 'GET', '/api/peer-sync/capabilities', '', hdr(initiatorNodeId, c.ts, c.sig));
    expect(cap.status).toBe(200);
    expect(cap.body.data.items[0].resourceType).toBe('document-store');
  });

  it('rejects bad signature and out-of-window timestamp', async () => {
    const { secret } = await pairAndGetSecret();
    // Wrong sig.
    const bad = await request(server, 'GET', '/api/peer-sync/ping', '', hdr(initiatorNodeId, String(Date.now()), 'deadbeef'));
    expect(bad.status).toBe(401);
    // Out-of-window ts (10 min ago) but otherwise correctly signed for that ts.
    const oldTs = String(Date.now() - 10 * 60 * 1000);
    const bodyHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
    const payload = `GET\n/api/peer-sync/ping\n${oldTs}\n${bodyHash}`;
    const sig = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('hex');
    const stale = await request(server, 'GET', '/api/peer-sync/ping', '', hdr(initiatorNodeId, oldTs, sig));
    expect(stale.status).toBe(401);
  });

  it('export returns a valid SyncResourceBundle with report content + contentHash', async () => {
    const { secret } = await pairAndGetSecret();
    const reqBody = JSON.stringify({ itemId: 'proj-1' });
    const e = sign(secret, 'POST', '/api/peer-sync/resources/document-store/export', reqBody);
    const exp = await request(server, 'POST', '/api/peer-sync/resources/document-store/export', reqBody, hdr(initiatorNodeId, e.ts, e.sig));
    expect(exp.status).toBe(200);
    const bundle = exp.body.data;
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.resourceType).toBe('document-store');
    expect(bundle.item.key).toBe('proj-1');
    expect(bundle.records).toHaveLength(1);
    const rec = bundle.records[0];
    expect(rec.title).toBe('登录页验收');
    expect(rec.content).toContain('# 登录页');
    expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.contentHash).toBe(crypto.createHash('sha256').update(rec.content).digest('hex'));
    expect(rec.metadata.verdict).toBe('pass');
    expect(rec.metadata.commitSha).toBe('abc1234');

    // signature endpoint returns a stable fingerprint.
    const sBody = JSON.stringify({ itemId: 'proj-1' });
    const s = sign(secret, 'POST', '/api/peer-sync/resources/document-store/signature', sBody);
    const sigRes = await request(server, 'POST', '/api/peer-sync/resources/document-store/signature', sBody, hdr(initiatorNodeId, s.ts, s.sig));
    expect(sigRes.status).toBe(200);
    expect(sigRes.body.data.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('unknown item -> 404; admin pairing-code endpoint mints a code', async () => {
    const { secret } = await pairAndGetSecret();
    const body = JSON.stringify({ itemId: 'does-not-exist' });
    const e = sign(secret, 'POST', '/api/peer-sync/resources/document-store/export', body);
    const exp = await request(server, 'POST', '/api/peer-sync/resources/document-store/export', body, hdr(initiatorNodeId, e.ts, e.sig));
    expect(exp.status).toBe(404);

    const mint = await request(server, 'POST', '/api/peer-sync/admin/pairing-codes', JSON.stringify({ displayName: 'x' }));
    expect(mint.status).toBe(201);
    expect(mint.body.pairingCode).toBeTruthy();
    expect(mint.body.selfNodeId).toMatch(/^[0-9a-f]{32}$/);
  });
});
