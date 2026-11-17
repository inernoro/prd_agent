import { randomBytes } from 'node:crypto';
import type { Plugin } from 'vite';

export const DEV_CSP_NONCE = '__PRD_DESKTOP_RESPONSE_NONCE__';

/** Tauri cannot inject its bundled-asset CSP into HTML served by devUrl. */
export function devCsp(policy: string): Plugin {
  return {
    name: 'desktop-dev-csp',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.end = new Proxy(res.end, {
          apply(end, receiver, args) {
            const body = args[0];
            if (String(res.getHeader('Content-Type')).includes('text/html') &&
                (typeof body === 'string' || Buffer.isBuffer(body))) {
              const nonce = randomBytes(24).toString('base64');
              const html = body.toString().replaceAll(DEV_CSP_NONCE, nonce);
              res.setHeader('Content-Security-Policy', policy.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`));
              res.setHeader('Cache-Control', 'no-store');
              res.removeHeader('ETag');
              res.setHeader('Content-Length', Buffer.byteLength(html));
              args[0] = html;
            }
            return Reflect.apply(end, receiver, args);
          },
        });
        next();
      });
    },
  };
}
