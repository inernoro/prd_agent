import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { designId, designPackageLimit } from '../services/design-package.js';
import type { DesignActor, DesignWorkspaceService } from '../services/design-workspace.js';
import { PlanningError, planningId, rejectPlanning } from '../services/engineering-planning-input.js';

const route = '/projects/:projectId/design';
const normalize = /^(?:\/_cds)?\/api\/projects\/[^/]+\/design(?:\/(packages|commands|artifacts\/[^/]+))?\/?$/i;
export function normalizedDesignPath(value: unknown): string | undefined {
  const match = String(value ?? '').split('?')[0].match(normalize);
  if (!match) return undefined;
  return '/api/projects/:projectId/design' + (match[1] ? '/' + match[1].toLowerCase().replace(/^artifacts\/.+$/, 'artifacts/:artifactId') : '');
}

const sandbox = [
  "sandbox allow-scripts", "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data: blob:", "font-src data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
].join('; ');

const prototypeBridge = `<script>
  (() => {
    const theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'dark' || theme === 'light') {
      const keepTheme = () => {
        const root = document.documentElement;
        if (root?.dataset.theme !== theme) root.dataset.theme = theme;
        if (root?.style.colorScheme !== theme) root.style.colorScheme = theme;
      };
      keepTheme();
      addEventListener('DOMContentLoaded', keepTheme, { once: true });
      new MutationObserver(keepTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    const elementBoxes = () => {
      const occurrences = new Map(), boxes = [];
      const nodes = document.querySelectorAll('[data-diff-id], h1, h2, h3, label, button, input, tr, [role=tab], [role=button]');
      for (const node of nodes) {
        const bounds = node.getBoundingClientRect();
        if (bounds.width < 4 || bounds.height < 4 || bounds.right <= 0 || bounds.bottom <= 0
          || bounds.left >= innerWidth || bounds.top >= innerHeight) continue;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.opacity === '0') continue;
        const base = node.getAttribute('data-diff-id') || node.id || node.tagName;
        const count = occurrences.get(base) || 0;
        occurrences.set(base, count + 1);
        const content = (node.textContent || node.getAttribute('placeholder') || '').slice(0, 300)
          + [style.color, style.backgroundColor, style.fontSize, style.fontWeight, style.borderColor].join('/');
        let digest = 5381;
        for (let i = 0; i < content.length; i += 1) digest = (digest * 33 ^ content.charCodeAt(i)) | 0;
        const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
        boxes.push({ id: base.slice(0, 80) + ':' + count, stamp: digest,
          x: left / innerWidth, y: top / innerHeight,
          width: (Math.min(bounds.right, innerWidth) - left) / innerWidth, height: (Math.min(bounds.bottom, innerHeight) - top) / innerHeight });
        if (boxes.length >= 350) break;
      }
      return boxes;
    };
    let pending = 0;
    const sendLayout = () => {
      clearTimeout(pending);
      pending = setTimeout(() => parent.postMessage({ type: 'cds-design-layout', boxes: elementBoxes() }, '*'), 180);
    };
    addEventListener('load', () => {
      sendLayout();
      new MutationObserver(sendLayout).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
    addEventListener('scroll', sendLayout, { capture: true, passive: true });
    addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.type !== 'cds-design-scroll') return;
      const { left, top } = event.data;
      if (Number.isFinite(left) && Number.isFinite(top)) scrollTo(left, top);
    });
    addEventListener('scroll', () => parent.postMessage({ type: 'cds-design-scroll', left: scrollX, top: scrollY }, '*'), { passive: true });
    addEventListener('keydown', (event) => {
      if (event.defaultPrevented || (event.key !== 'Escape' && event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable]'))) return;
      if (['ArrowLeft', 'ArrowRight', 'c', 'C', 'Escape'].includes(event.key)) {
        parent.postMessage({ type: 'cds-design-key', key: event.key }, '*');
      }
    });
  })();
</script>`;

export function createDesignWorkspaceRouter(deps: {
  service: DesignWorkspaceService;
  resolveAccess: (req: Request, projectId: string) => DesignActor | null | Promise<DesignActor | null>;
}): Router {
  const router = express.Router();
  function failure(error: unknown, res: Response) {
    if (error instanceof PlanningError) {
      res.status(error.status).json({ error: error.code, message: error.message });
    } else {
      res.status(503).json({ error: 'design_unavailable', message: '设计工作区暂不可用，请使用原请求编号重试' });
    }
  }
  async function authorized(req: Request, res: Response, next: NextFunction) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const projectId = planningId(req.params.projectId, 'projectId');
      const actor = await deps.resolveAccess(req, projectId);
      if (!actor?.permissions.includes('read')) return rejectPlanning(404, 'design_not_found', '没有可访问的设计项目');
      res.locals.designAccess = { actor, projectId };
      next();
    } catch (error) { failure(error, res); }
  }
  function handle(run: (req: Request, res: Response, projectId: string, actor: DesignActor) => unknown) {
    return async (req: Request, res: Response) => {
      const { projectId, actor } = res.locals.designAccess as { projectId: string; actor: DesignActor };
      try { await run(req, res, projectId, actor); } catch (error) { failure(error, res); }
    };
  }

  router.get(route, authorized, handle(async (_req, res, projectId, actor) => res.json(await deps.service.workspace(projectId, actor))));
  router.post(`${route}/packages`, authorized, express.raw({ type: 'application/zip', limit: designPackageLimit, inflate: false }),
    handle(async (req, res, projectId, actor) => {
      const info = await deps.service.publish(projectId, actor, req.query, req.body);
      res.status(info.reused ? 200 : 201).json(info);
    }));
  router.post(`${route}/commands`, authorized, express.json({ limit: '8mb' }),
    handle(async (req, res, projectId, actor) => {
      const info = await deps.service.command(projectId, actor, req.body);
      res.status(info.reused ? 200 : 201).json(info);
    }));
  router.get(`${route}/artifacts/:id`, authorized, handle(async (req, res, projectId, actor) => {
    const artifact = await deps.service.artifact(projectId, actor, designId(req.params.id, '稿件附件'));
    res.setHeader('Content-Type', artifact.mime);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (artifact.mime.startsWith('text/html')) {
      res.setHeader('Content-Security-Policy', sandbox);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    if (artifact.mime.startsWith('text/html') && (req.query.theme === 'light' || req.query.theme === 'dark')) {
      const html = artifact.bytes.toString('utf8');
      const separator = html.match(/<head(?:\s[^>]*)?>/i);
      const index = separator ? separator.index! + separator[0].length : 0;
      if (index > 0) { res.send(html.slice(0, index) + prototypeBridge + html.slice(index)); return; }
      res.send(html.replace(/^(<!doctype[^>]+>\s*)?/i, start => start + prototypeBridge));
      return;
    }
    res.send(artifact.bytes);
  }));
  router.use((error: { status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (!res.locals.designAccess || ![400, 413, 415].includes(error.status ?? 0)) return next(error);
    res.status(error.status!).json({ error: 'invalid_design', message: error.status === 413 ? '稿件或证据超过体积限制' : '请按设计接口提交有效的 ZIP 或 JSON' });
  });
  return router;
}
