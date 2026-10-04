#!/usr/bin/env node
// REG-cds-self-runnable-prebuilt-001：真实运行镜像探针，不以产物存在替代服务启动。
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function verifyPreviewRuntime(baseUrl, expectedSha, { request = fetch, username, password } = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('目标提交必须是完整 SHA');
  const origin = new URL(baseUrl).origin;
  const get = async (pathname, options = {}) => {
    const response = await request(new URL(pathname, origin), {
      ...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) throw new Error(`${pathname} 未返回预期成功状态`);
    return response;
  };
  const instance = await (await get('/api/instance-mode')).json();
  if (instance.previewInstance !== true) throw new Error('服务不是隔离预览实例');
  if (!username || !password) throw new Error('缺少独立预览登录凭据');
  const login = await get('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('独立预览登录未创建会话');
  const headers = { Cookie: cookie };
  const manifest = await (await get('/preview-build.json', { headers })).json();
  if (manifest.schema !== 1 || manifest.sha !== expectedSha) throw new Error('运行镜像版本与目标提交不一致');
  const htmlResponse = await get('/reports', { headers });
  if (!htmlResponse.headers.get('content-type')?.includes('text/html')) throw new Error('功能入口不是 HTML');
  const html = await htmlResponse.text();
  if (!html.includes('__CDS_PREVIEW_INSTANCE__')) throw new Error('页面缺少独立预览身份标记');
  const resources = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map((match) => match[1]);
  if (!resources.some((resource) => /\.js(?:\?|$)/.test(resource))) throw new Error('页面没有真实入口脚本');
  for (const resource of resources) {
    const url = new URL(resource, origin);
    if (url.origin !== origin) throw new Error('页面入口资源不是同源资源');
    const response = await get(`${url.pathname}${url.search}`, { headers });
    const mime = response.headers.get('content-type') || '';
    if (/\.js(?:\?|$)/.test(resource) ? !/javascript/.test(mime) : !/text\/css/.test(mime)) throw new Error('入口资源类型不符');
    if ((await response.arrayBuffer()).byteLength === 0) throw new Error('入口资源为空');
  }
  const projectList = await (await get('/api/projects', { headers })).json();
  const projects = Array.isArray(projectList) ? projectList : projectList.projects;
  const projectId = projects?.[0]?.id;
  if (typeof projectId !== 'string' || !projectId) throw new Error('预览实例没有可访问的项目');
  const query = `?projectId=${encodeURIComponent(projectId)}`;
  const tasks = await (await get(`/api/acceptance/tasks${query}`, { headers })).json();
  const templates = await (await get(`/api/acceptance/templates${query}`, { headers })).json();
  if (!Array.isArray(tasks.tasks) || !Array.isArray(templates.templates)) throw new Error('结构化验收接口未就绪');
  return { previewInstance: true, commit: expectedSha, resourceCount: resources.length, acceptanceRoutes: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyPreviewRuntime(process.argv[2], process.argv[3], {
      username: process.env.CDS_PREVIEW_USERNAME, password: process.env.CDS_PREVIEW_PASSWORD,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    // 不输出响应、会话或请求 body，以免把凭据带入 CI 日志。
    console.error(error.message);
    process.exitCode = 1;
  }
}
