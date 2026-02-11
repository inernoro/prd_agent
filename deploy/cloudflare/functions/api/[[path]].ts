/**
 * Cloudflare Pages Function: API 反向代理
 *
 * 将前端的 /api/* 请求代理到后端 API 服务器。
 * 后端地址通过 Cloudflare Pages 环境变量 API_BACKEND_URL 配置。
 *
 * 使用方式:
 *   1. 在 Cloudflare Dashboard → Pages → Settings → Environment variables 中设置:
 *      API_BACKEND_URL = https://api.yourdomain.com (你的后端地址)
 *   2. 将此文件放在 functions/api/ 目录下 (由 deploy 脚本自动复制)
 *
 * 文档: https://developers.cloudflare.com/pages/functions/
 */

interface Env {
  API_BACKEND_URL: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const backendUrl = context.env.API_BACKEND_URL;

  if (!backendUrl) {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: 'PROXY_NOT_CONFIGURED',
          message: 'API_BACKEND_URL environment variable is not set',
        },
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 构建后端 URL: 保留原始路径和查询参数
  const url = new URL(context.request.url);
  const targetUrl = `${backendUrl.replace(/\/+$/, '')}${url.pathname}${url.search}`;

  // 复制请求头，移除 Cloudflare 特有头
  const headers = new Headers(context.request.headers);
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');
  headers.set('X-Forwarded-For', context.request.headers.get('cf-connecting-ip') || '');
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Real-IP', context.request.headers.get('cf-connecting-ip') || '');

  try {
    const response = await fetch(targetUrl, {
      method: context.request.method,
      headers,
      body: context.request.method !== 'GET' && context.request.method !== 'HEAD'
        ? context.request.body
        : undefined,
      // @ts-expect-error — Cloudflare Workers 支持 duplex 选项用于流式请求体
      duplex: 'half',
    });

    // 构建响应，传递原始状态码和头
    const responseHeaders = new Headers(response.headers);

    // SSE 流式响应: 禁用缓冲
    if (responseHeaders.get('content-type')?.includes('text/event-stream')) {
      responseHeaders.set('Cache-Control', 'no-cache');
      responseHeaders.set('X-Accel-Buffering', 'no');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown proxy error';
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: 'PROXY_ERROR',
          message: `Failed to proxy request: ${message}`,
        },
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
