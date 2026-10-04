import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseCdsCompose } from '../../src/services/compose-parser.js';
import { verifyPreviewRuntime } from '../../scripts/verify-preview-runtime.mjs';

const SHA = 'a'.repeat(40);
const cdsRoot = process.cwd();
const base = 'http://127.0.0.1:19900';
const credentials = { username: 'stsmk-unit', password: 'private-fixture-password' };

function probeRequest(change: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown> = {
    '/api/instance-mode': { previewInstance: true },
    '/api/login': { success: true },
    '/api/projects': { projects: [{ id: 'preview-demo' }] },
    '/preview-build.json': { schema: 1, sha: SHA },
    '/reports': '<html><script>window.__CDS_PREVIEW_INSTANCE__=true</script><script src="/assets/app.js"></script><link href="/assets/app.css"></html>',
    '/assets/app.js': 'globalThis.app = true;',
    '/assets/app.css': 'body { color: black; }',
    '/api/acceptance/tasks': { tasks: [] },
    '/api/acceptance/templates': { templates: [] },
    ...change,
  };
  const observed: Array<{ path: string; cookie?: string; body?: string }> = [];
  const request = async (input: URL, options: RequestInit = {}) => {
    const pathname = input.pathname;
    observed.push({ path: `${pathname}${input.search}`, cookie: (options.headers as Record<string, string>)?.Cookie, body: options.body as string });
    if (!(pathname in bodies)) return new Response('', { status: 404 });
    const body = bodies[pathname];
    const headers = new Headers();
    if (pathname === '/api/login') headers.set('set-cookie', 'cds_session=private-session; HttpOnly');
    if (pathname === '/reports') headers.set('content-type', 'text/html');
    else if (pathname.endsWith('.js')) headers.set('content-type', 'application/javascript');
    else if (pathname.endsWith('.css')) headers.set('content-type', 'text/css');
    else headers.set('content-type', 'application/json');
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers });
  };
  return { request, observed };
}

describe('REG-cds-self-runnable-prebuilt-001', () => {
  it('配置解析为独立不可变预构建服务，没有源码或宿主挂载', () => {
    const text = fs.readFileSync(path.join(cdsRoot, 'cds-compose.preview.yml'), 'utf8');
    const config = parseCdsCompose(text)!;
    expect(config.buildProfiles).toHaveLength(1);
    const service = config.buildProfiles[0];
    expect(service.prebuiltImage).toBe(true);
    expect(service.dockerImage).toContain('cds-preview:sha-${CDS_COMMIT_SHA}');
    expect(service.deployModes?.express.prebuilt).toBe(true);
    expect(service.env).toEqual({ CDS_PREVIEW_INSTANCE: '1', CDS_STORAGE_MODE: 'json' });
    expect(service.command).toBeUndefined();
    const document = yaml.load(text) as { services: { cds: { volumes?: unknown } } };
    expect(document.services.cds.volumes).toBeUndefined();
    expect(service.resources).toEqual({ memoryMB: 768, cpus: 1 });
  });

  it('探针检查真实会话、版本、全部入口资源与项目作用域的接口', async () => {
    const { request, observed } = probeRequest();
    const result = await verifyPreviewRuntime(base, SHA, { request, ...credentials });
    expect(result).toEqual({ previewInstance: true, commit: SHA, resourceCount: 2, acceptanceRoutes: true });
    expect(observed.find((item) => item.path === '/api/login')?.body).toBe(JSON.stringify(credentials));
    expect(observed.some((item) => item.path === '/api/acceptance/tasks?projectId=preview-demo')).toBe(true);
    expect(observed.some((item) => item.path === '/assets/app.css')).toBe(true);
    expect(observed.find((item) => item.path === '/reports')?.cookie).toBe('cds_session=private-session');
    expect(JSON.stringify(result)).not.toContain(credentials.password);
    expect(JSON.stringify(result)).not.toContain('private-session');
  });

  it.each([
    ['/api/instance-mode', { previewInstance: false }, '服务不是隔离预览实例'],
    ['/preview-build.json', { schema: 1, sha: 'b'.repeat(40) }, '运行镜像版本与目标提交不一致'],
    ['/reports', '<html>empty</html>', '页面缺少独立预览身份标记'],
    ['/assets/app.js', '', '入口资源为空'],
    ['/api/acceptance/tasks', { error: 'Unknown API endpoint' }, '结构化验收接口未就绪'],
    ['/api/projects', { projects: [] }, '预览实例没有可访问的项目'],
  ])('拒绝失真运行状态 %s', async (route, body, reason) => {
    await expect(verifyPreviewRuntime(base, SHA, { ...probeRequest({ [route]: body }), ...credentials })).rejects.toThrow(reason);
  });

  it('入口资源缺失不能用 HTML 或健康通过顶替', async () => {
    const { request } = probeRequest();
    await expect(verifyPreviewRuntime(base, SHA, {
      ...credentials,
      request: async (url: URL, options: RequestInit) => url.pathname.endsWith('.css') ? new Response('', { status: 404 }) : request(url, options),
    })).rejects.toThrow('未返回预期成功状态');
  });

  it('拒绝外站入口脚本', async () => {
    const { request } = probeRequest({ '/reports': '<html>__CDS_PREVIEW_INSTANCE__<script src="https://elsewhere.example/app.js"></script></html>' });
    await expect(verifyPreviewRuntime(base, SHA, { request, ...credentials })).rejects.toThrow('不是同源资源');
  });

  it('缺少独立身份时不能以公开页面可访问冒充认证通过', async () => {
    await expect(verifyPreviewRuntime(base, SHA, probeRequest())).rejects.toThrow('缺少独立预览登录凭据');
  });

  it('CI 使用真实运行镜像，探针成功后才发布且不调用共享更新', () => {
    const workflow = fs.readFileSync(path.resolve(cdsRoot, '..', '.github/workflows/cds-prebuilt.yml'), 'utf8');
    const probeIndex = workflow.indexOf('Verify runnable isolated preview before publishing');
    expect(probeIndex).toBeGreaterThan(0);
    expect(workflow.indexOf('Publish verified CDS isolated preview runtime')).toBeGreaterThan(probeIndex);
    expect(workflow).toContain('node cds/scripts/verify-preview-runtime.mjs');
    expect(workflow).not.toContain('self update');
    const dockerfile = fs.readFileSync(path.join(cdsRoot, 'Dockerfile.preview'), 'utf8');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
    expect(dockerfile).toContain('COPY --chown=node:node src/services/preview-demo-snapshot.json ./src/services/preview-demo-snapshot.json');
    expect(dockerfile).not.toMatch(/docker\.sock|COPY\s+\.\s/);
  });
});
