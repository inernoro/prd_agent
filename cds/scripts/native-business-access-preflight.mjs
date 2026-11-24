import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const TARGET = 'eab37570f6dc6dcc02902c4bddacb460c1744a27';
const IMAGES = ['md-imp/mdimp/mdimp-admin-api', 'md-imp/mdimp/mdimp-admin'];
const BODY_LIMIT = 65536;
const OCI_TYPE = /^application\/vnd\.(?:oci\.image\.(?:index|manifest)\.v1|docker\.distribution\.manifest(?:\.list)?\.v2)\+json(?:;|$)/i;

async function boundedJson(response) {
  if (!response.body) throw new Error('invalid_json');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > BODY_LIMIT) throw new Error('body_limit');
      chunks.push(Buffer.from(result.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

// Only this workflow's short-lived token is used. Never return request headers,
// registry tokens, response bodies, or exception messages in the report.
export async function probeNativeBusinessAccess({ token, actor, fetchImpl = fetch }) {
  const report = { schema: 1, targetCommit: TARGET, probes: [], accessAvailable: false,
    actualBusinessReadyVerified: false, imageIdentityVerified: false, formalAcceptancePassed: false };
  if (!token || !/^[a-zA-Z0-9-]+$/.test(actor || '')) {
    report.inputError = 'workflow_credentials_unavailable'; return report;
  }
  const request = (url, options) => fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
  const source = { kind: 'source-commit', repository: 'MD-IMP/mdimp', status: null, confirmed: false };
  try {
    const response = await request(`https://api.github.com/repos/MD-IMP/mdimp/git/commits/${TARGET}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    source.status = response.status;
    if (response.status === 200) {
      source.confirmed = (await boundedJson(response)).sha === TARGET;
      if (!source.confirmed) source.error = 'target_mismatch';
    } else { await response.body?.cancel(); source.error = 'source_access_denied'; }
  } catch { source.error = 'source_request_unconfirmed'; }
  report.probes.push(source);

  for (const image of IMAGES) {
    const row = { kind: 'image-manifest', image, tag: `sha-${TARGET}`, tokenStatus: null, status: null, confirmed: false };
    try {
      const auth = await request(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${image}:pull`)}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` },
      });
      row.tokenStatus = auth.status;
      if (auth.status !== 200) {
        await auth.body?.cancel(); row.error = 'registry_access_denied';
      } else {
        const credential = (await boundedJson(auth)).token;
        if (typeof credential !== 'string' || !credential) row.error = 'registry_credential_unconfirmed';
        else {
          const response = await request(`https://ghcr.io/v2/${image}/manifests/sha-${TARGET}`, { method: 'HEAD', headers: {
            Authorization: `Bearer ${credential}`,
            Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
          } });
          row.status = response.status;
          const digest = response.headers.get('docker-content-digest');
          row.confirmed = response.status === 200 && OCI_TYPE.test(response.headers.get('content-type') || '')
            && /^sha256:[a-f0-9]{64}$/.test(digest || '');
          if (row.confirmed) row.manifestDigest = digest;
          else row.error = response.status === 200 ? 'manifest_unconfirmed' : 'manifest_access_denied';
          await response.body?.cancel();
        }
      }
    } catch { row.error = 'registry_request_unconfirmed'; }
    report.probes.push(row);
  }
  report.accessAvailable = report.probes.every(row => row.confirmed);
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const report = await probeNativeBusinessAccess({ token: process.env.GH_TOKEN, actor: process.env.GITHUB_ACTOR });
  report.at = new Date().toISOString();
  report.runtime = { platform: os.platform(), architecture: os.arch(), nodeVersion: process.version,
    githubRunId: process.env.GITHUB_RUN_ID || null, sourceHead: process.env.GITHUB_SHA || null,
    scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') };
  report.runtime.containerLimits = {};
  for (const file of ['cpu.max', 'memory.max', 'pids.max']) {
    report.runtime.containerLimits[file] = await readFile(`/sys/fs/cgroup/${file}`, 'utf8')
      .then(value => value.trim().slice(0, 64)).catch(() => null);
  }
  report.scope = 'read-only workflow-token access prerequisite; no clone, image pull, application start, deploy or production request';
  const output = path.resolve(process.argv[2] || 'native-business-access-output/report.json');
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
  process.exitCode = report.accessAvailable ? 0 : 1;
}
