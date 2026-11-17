import { createHash } from 'node:crypto';

/** Verify both published entry bundles and media before a credentialed browser starts. */
export async function waitForEntryPreviews({ map, gateway, motion, expectedCommit,
  fetcher = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 12 * 60_000, retryMs = 15_000, log = console.log }) {
  const deadline = now() + timeoutMs;
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' };
  const get = url => fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
  let latest = [];
  while (true) {
    latest = await Promise.all([['map', map], ['gateway', gateway]].map(async ([app, destination]) => {
      const origin = new URL(destination);
      const result = { app, origin: origin.origin, ready: false };
      try {
        const response = await get(origin);
        const html = await response.text();
        const source = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)/)?.[1];
        const branchId = html.match(/var BRANCH_ID=['"]([^'"]+)['"]/i)?.[1];
        if (!response.ok || !source || !branchId) return { ...result, reason: 'entry HTML unavailable' };
        const state = await get(new URL('/_cds/api/branches', origin));
        const branches = await state.json();
        const deployed = branches.branches?.find(branch => branch.id === branchId)?.runningCommitSha;
        if (!state.ok || deployed !== expectedCommit) return { ...result, reason: 'expected revision not running' };
        const bundleUrl = new URL(source, origin);
        if (bundleUrl.origin !== origin.origin) return { ...result, reason: 'unexpected entry origin' };
        const bundle = await get(bundleUrl);
        const javascript = await bundle.text();
        // Both current app entry bundles contain their shared portrait constant.
        // MAP must not be accepted solely because Gateway or the branch API is ready.
        if (!bundle.ok || !javascript.includes(motion.fileName)
          || (app === 'gateway' && !javascript.includes('direct-night'))) {
          return { ...result, reason: 'expected entry artwork not referenced' };
        }
        const media = await get(new URL(`/media/entry/${motion.fileName}`, origin));
        if (!media.ok) return { ...result, reason: 'portrait media unavailable' };
        const sha256 = createHash('sha256').update(new Uint8Array(await media.arrayBuffer())).digest('hex');
        if (sha256 !== motion.sha256) return { ...result, reason: 'portrait media hash differs' };
        return { ...result, ready: true, branchId, commit: deployed, bundle: bundleUrl.pathname, mediaSha256: sha256 };
      } catch {
        return { ...result, reason: 'public resource request not ready' };
      }
    }));
    if (latest.every(app => app.ready)) return { expectedCommit, checkedAt: new Date().toISOString(), apps: latest };
    if (now() >= deadline) throw new Error(`Public entry previews not ready: ${latest.filter(app => !app.ready).map(app => `${app.origin}: ${app.reason}`).join('; ')}`);
    log('Waiting for both expected public entry builds:', latest.filter(app => !app.ready).map(app => app.origin).join(', '));
    await sleep(retryMs);
  }
}
