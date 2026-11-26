import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArtifactVerificationAttempt } from '../src/services/artifact-verification-probe.js';

const baseline = process.argv[2] === '--baseline' && process.argv[3];
assert(process.argv.length === 2 || (baseline && process.argv.length === 4),
  'Usage: pnpm exec tsx scripts/verify-artifact-retry.ts [--baseline <repository worktree>]');
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 10_000 }).trim();
const localEndpoint = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
assert(localEndpoint.startsWith('unix://') && (!process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith('unix://')),
  'Run against an isolated local Docker daemon. The fixture registry listens only on loopback.');

const sourceRoot = baseline ? pathToFileURL(resolve(baseline, 'cds/src/services') + '/') : new URL('../src/services/', import.meta.url);
const { inspectDeploymentArtifacts }: typeof import('../src/services/artifact-admission.js') =
  await import(new URL('artifact-admission.ts', sourceRoot).href);
const { configureImageCacheGovernance, ImageCacheGovernance }: typeof import('../src/services/image-cache-governance.js') =
  await import(new URL('image-cache-governance.ts', sourceRoot).href);
const { ShellExecutor }: typeof import('../src/services/shell-executor.js') =
  await import(new URL('shell-executor.ts', sourceRoot).href);

const revision = randomBytes(20).toString('hex');
const namespace = `cds-retry-fixture-${revision.slice(0, 12)}`;
const tag = `sha-${revision}`;
const [os, daemonArchitecture] = docker('info', '--format', '{{.OSType}} {{.Architecture}}').split(' ');
const architecture = daemonArchitecture === 'x86_64' ? 'amd64' : daemonArchitecture === 'aarch64' ? 'arm64' : daemonArchitecture;
const roles = ['api', 'admin', 'gateway', 'gateway-serve', 'gateway-web', 'design'];
const lastRole = roles.at(-1)!;
const sha = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = (body: unknown) => Buffer.from(JSON.stringify(body));
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const artifacts = new Map(roles.map(role => {
  const config = json({ architecture, os, created: new Date().toISOString(), rootfs: { type: 'layers', diff_ids: [] },
    config: { Labels: { 'org.opencontainers.image.revision': revision, 'cds.fixture.role': `${namespace}-${role}` } } });
  const manifest = json({ schemaVersion: 2, mediaType: manifestType, layers: [],
    config: { mediaType: configType, digest: sha(config), size: config.length } });
  return [role, { config, manifest, requests: 0 }];
}));
const registry = createServer((req, res) => {
  res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
  if (req.url === '/v2/') { res.end('{}'); return; }
  const match = req.url?.match(new RegExp(`^/v2/${namespace}/([^/]+)/(manifests|blobs)/([^?]+)$`));
  const artifact = match && artifacts.get(match[1]);
  if (!match || !artifact) { res.writeHead(404).end(); return; }
  const isManifest = match[2] === 'manifests';
  const bytes = isManifest ? artifact.manifest : artifact.config;
  const digest = sha(bytes);
  if ((match[3] !== tag || !isManifest) && match[3] !== digest) { res.writeHead(404).end(); return; }
  if (isManifest) artifact.requests++;
  res.setHeader('Docker-Content-Digest', digest);
  res.setHeader('Content-Type', isManifest ? manifestType : configType);
  res.setHeader('Content-Length', bytes.length);
  res.end(req.method === 'HEAD' ? undefined : bytes);
});
registry.listen(0, '127.0.0.1');
await once(registry, 'listening');
const address = registry.address();
assert(address && typeof address === 'object');
const profiles = roles.map(id => ({ id, name: id, dockerImage: `127.0.0.1:${address.port}/${namespace}/${id}:${tag}`,
  projectId: namespace, prebuiltImage: true, workDir: '.', command: '', containerPort: 80 }));
const catalog = mkdtempSync(join(tmpdir(), 'cds-retry-fixture-'));
const shell = new ShellExecutor();
const cache = new ImageCacheGovernance({ shell, catalog, instanceId: namespace, budgetBytes: 16 * 1024 ** 3, protectedReferences: () => [] });

let completedPulls = 0;
let expired = false;
const pull = cache.executePull.bind(cache);
cache.executePull = async (...args) => {
  const result = await pull(...args);
  if (result.recorded && result.outcome === 'success') completedPulls++;
  return result;
};
const prepare = cache.prepare.bind(cache);
cache.prepare = async (...args) => {
  const result = await prepare(...args);
  // Spend the round's budget once the sixth reservation is durable. The same fault
  // applies on retry if the control plane again pulls all five preceding images.
  if (completedPulls === 5 && args[0] === profiles.at(-1)!.dockerImage) expired = true;
  return result;
};
const remainingMs = () => {
  if (expired) throw new Error('Fixture exhausted the inspection budget before starting the sixth pull');
  return 45_000;
};

configureImageCacheGovernance(cache);
try {
  const firstProbe = new ArtifactVerificationAttempt();
  const first = await inspectDeploymentArtifacts(shell, profiles, revision, () => {}, { remainingMs, measurement: firstProbe });
  assert.equal(first.state, 'waiting');
  assert.deepEqual(first.profileIds, [lastRole]);
  assert.deepEqual(first.artifacts, []);
  const ledger = JSON.parse(readFileSync(join(catalog, 'images.json'), 'utf8'));
  const heldBytes = Object.values(ledger.pulls as Record<string, { confirmed?: boolean; reserveBytes: number }>)
    .reduce((total, row) => total + (row.confirmed ? 0 : row.reserveBytes), 0);
  const firstRoundRequests = new Map([...artifacts].map(([role, evidence]) => [role, evidence.requests]));
  assert([...firstRoundRequests].slice(0, -1).every(([, requests]) => requests > 0));
  assert.equal(firstRoundRequests.get(lastRole), 0);

  completedPulls = 0;
  expired = false;
  const retryProbe = new ArtifactVerificationAttempt(true);
  const retry = await inspectDeploymentArtifacts(shell, profiles, revision, () => {}, {
    remainingMs, measurement: retryProbe, retry: { profileId: lastRole },
  });
  const repeatedRoles = roles.slice(0, -1).filter(role => artifacts.get(role)!.requests > firstRoundRequests.get(role)!);
  if (baseline) {
    assert.equal(retry.state, 'waiting');
    assert.deepEqual(retry.profileIds, [lastRole]);
    assert(heldBytes > 0);
    assert.deepEqual(repeatedRoles, roles.slice(0, -1));
  } else {
    assert.equal(retry.state, 'ready');
    assert.equal(retry.artifacts.length, roles.length);
    assert.equal(heldBytes, 0);
    assert.deepEqual(repeatedRoles, []);
    assert(firstProbe.snapshot().signals?.includes('pull-never-started'));
    assert.equal(retryProbe.snapshot().pullRequests, 1);
    assert.equal(retryProbe.snapshot().reusedImages, 5);
    for (const artifact of retry.artifacts) {
      assert(artifact.image.endsWith('@' + sha(artifacts.get(artifact.profileIds[0])!.manifest)));
      assert.equal(artifact.revision, revision);
      assert.equal(artifact.platform, `${os}/${architecture}`);
    }
  }
  console.log(JSON.stringify({ mode: baseline ? 'baseline' : 'candidate', first: first.state, retry: retry.state,
    heldBytesAfterFirst: heldBytes, repeatedRoles, retryProbe: baseline ? undefined : retryProbe.snapshot() }));
} finally {
  configureImageCacheGovernance(undefined);
  for (const profile of profiles) {
    try { execFileSync('docker', ['image', 'rm', profile.dockerImage], { stdio: 'ignore', timeout: 5_000 }); }
    catch { /* The fixture may not have pulled this image. */ }
  }
  registry.close();
  rmSync(catalog, { recursive: true, force: true });
}
