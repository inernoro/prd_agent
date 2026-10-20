import { describe, it, expect } from 'vitest';
import { probeNativeBusinessAccess } from '../../scripts/native-business-access-preflight.mjs';

const target = 'eab37570f6dc6dcc02902c4bddacb460c1744a27';
const token = 'private-workflow-credential-never-record';
const registryToken = 'private-registry-credential-never-record';
const digest = 'sha256:' + 'a'.repeat(64);
const ok = async (url: string) => {
  if (url.includes('api.github.com')) return new Response(JSON.stringify({ sha: target }));
  if (url.includes('/token?')) return new Response(JSON.stringify({ token: registryToken }));
  return new Response(null, { headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json', 'docker-content-digest': digest } });
};

describe('原生业务访问前提', () => {
  it('同时确认原提交和两份OCI访问，但不宣称业务就绪或镜像身份已验证', async () => {
    const report = await probeNativeBusinessAccess({ token, actor: 'inernoro', fetchImpl: ok });
    expect(report.accessAvailable).toBe(true);
    expect(report.probes).toHaveLength(3);
    expect(report.actualBusinessReadyVerified).toBe(false);
    expect(report.imageIdentityVerified).toBe(false);
    expect(report.formalAcceptancePassed).toBe(false);
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain(registryToken);
  });

  it('HTTP200返回其他提交不能通过目标校验', async () => {
    const report = await probeNativeBusinessAccess({ token, actor: 'inernoro', fetchImpl: async (url: string) =>
      url.includes('api.github.com') ? new Response(JSON.stringify({ sha: 'b'.repeat(40) })) : ok(url) });
    expect(report.accessAvailable).toBe(false);
    expect(report.probes[0].error).toBe('target_mismatch');
  });

  it('拒绝访问保留实际状态码，错误正文中的凭据不能进入报告', async () => {
    const report = await probeNativeBusinessAccess({ token, actor: 'inernoro', fetchImpl: async (url: string) =>
      new Response(token + registryToken, { status: url.includes('api.github.com') ? 404 : 403 }) });
    expect(report.accessAvailable).toBe(false);
    expect(report.probes[0].status).toBe(404);
    expect(report.probes[1].tokenStatus).toBe(403);
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain(registryToken);
  });

  it('伪装HTTP200的HTML或无摘要响应不能当OCI访问成功', async () => {
    const report = await probeNativeBusinessAccess({ token, actor: 'inernoro', fetchImpl: async (url: string) =>
      url.includes('/manifests/') ? new Response(null, { headers: { 'content-type': 'text/html', 'docker-content-digest': digest } }) : ok(url) });
    expect(report.accessAvailable).toBe(false);
    expect(report.probes[1].error).toBe('manifest_unconfirmed');
  });

  it('异常信息即使含凭据也只记录未确认类别', async () => {
    const report = await probeNativeBusinessAccess({ token, actor: 'inernoro', fetchImpl: async () => { throw new Error(token); } });
    expect(report.accessAvailable).toBe(false);
    expect(report.probes[0].error).toBe('source_request_unconfirmed');
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it('超过64KiB的响应不被接受为有效源或凭据', async () => {
    const report = await probeNativeBusinessAccess({ token, actor: 'inernoro', fetchImpl: async () =>
      new Response(JSON.stringify({ sha: target, token: registryToken, padding: 'x'.repeat(65536) })) });
    expect(report.accessAvailable).toBe(false);
    expect(report.probes.every((row: { confirmed: boolean }) => !row.confirmed)).toBe(true);
  });
});
