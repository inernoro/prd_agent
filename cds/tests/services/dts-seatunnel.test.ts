import http from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, it, expect } from 'vitest';
import { DtsSeaTunnel } from '../../src/services/dts-seatunnel.js';
import type { StateService } from '../../src/services/state.js';
import type { ServerEventLogSink, ServerEventRecord } from '../../src/services/server-event-log-store.js';
const servers: http.Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } });
async function fixture(body: string, code = 200) {
  const requests: { url?: string; authorization?: string }[] = [], records: ServerEventRecord[] = [];
  const server = http.createServer((req,res) => { requests.push({ url: req.url, authorization: req.headers.authorization }); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); servers.push(server);
  const binding = { projectId: 'p', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, version: '3.0.0' as const, usernameEnv: 'USER', passwordEnv: 'PASSWORD' };
  const engine = new DtsSeaTunnel({ getCustomEnv: () => ({ USER: 'fixture-admin', PASSWORD: 'fixture-private-password' }) } as unknown as StateService,
    { async recordImmediate(row: ServerEventRecord) { records.push(row); }, async findRecent() { return records; } } as unknown as ServerEventLogSink);
  return { binding, engine, requests, records };
}
describe('DTS original engine protocol and durable redaction', () => {
  it('retains a hash of the actual upstream body without exposing job secrets', async () => {
    const raw = JSON.stringify({ jobId: '123', jobName: 'cds-dts-run', jobStatus: 'FINISHED', jobConfig: { password: 'fixture-private-password' } });
    const f = await fixture(raw); await f.engine.call(f.binding,'status','123',undefined,'run');
    const proof = f.records[0].details as Record<string, unknown>;
    expect(proof.responseSha256).toBe(createHash('sha256').update(raw).digest('hex')); expect(proof.originalBytes).toBe(Buffer.byteLength(raw));
    expect(JSON.stringify(f.records)).not.toContain('fixture-private-password'); expect(String(proof.snapshot)).not.toContain('jobConfig'); expect(f.records[0].severity).toBe('info');
  });
  it('rejects a different native job identity instead of treating its FINISHED as success', async () => {
    const f = await fixture(JSON.stringify({ jobId:'123',jobName:'another-run',jobStatus:'FINISHED' }));
    await expect(f.engine.call(f.binding,'status','123',undefined,'run')).rejects.toThrow('尚未核实');
  });
  it('pins the caller-assigned native id and run name during submit', async () => {
    const f = await fixture(JSON.stringify({ jobId:'123',jobName:'cds-dts-run' })); await f.engine.call(f.binding,'submit','123',{ env: {} },'run');
    expect(f.requests[0].url).toBe('/submit-job?jobId=123&jobName=cds-dts-run');
  });
  it('records malformed responses by original hash while returning a safe recovery message', async () => {
    const raw = '<html>password=fixture-private-password</html>', f = await fixture(raw,502);
    await expect(f.engine.call(f.binding,'overview')).rejects.toThrow('勿重复'); expect(JSON.stringify(f.records)).not.toContain('fixture-private-password');
    expect((f.records[0].details as Record<string, unknown>).responseSha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });
  it('rejects unsafe integer native identifiers before sending any request', async () => {
    const f = await fixture('{}'); await expect(f.engine.call(f.binding,'stop','9999999999999999')).rejects.toThrow('编号'); expect(f.requests).toHaveLength(0);
  });
});
