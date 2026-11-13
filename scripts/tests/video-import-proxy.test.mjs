import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dockerAvailable = spawnSync('docker', ['info'], { timeout: 10000, stdio: 'ignore' }).status === 0;
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
};
const request = (port, uri, length, body) => new Promise((resolve, reject) => {
  let receivedContinue = false;
  const req = http.request({ hostname: '127.0.0.1', port, path: uri, method: 'POST', headers: {
    'Content-Length': length, Authorization: 'Bearer proxy-fixture',
    ...(body == null ? { Expect: '100-continue' } : {}),
  } });
  req.on('continue', () => { receivedContinue = true; resolve({ status: 100 }); req.destroy(); });
  req.on('response', response => {
    response.resume();
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
  });
  req.on('error', error => { if (!receivedContinue) reject(error); });
  req.setTimeout(5000, () => req.destroy(new Error('nginx request timed out')));
  if (body == null) req.flushHeaders();
  else req.end(body);
});

for (const file of ['deploy/nginx/nginx.conf', 'deploy/nginx/conf.d/branches/_standalone.conf']) {
  test(`${file}: import allowance is bounded and preserves API forwarding`, { skip: !dockerAvailable }, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'video-import-proxy-'));
    const name = `video-import-proxy-${randomUUID()}`;
    try {
      const source = readFileSync(path.join(root, file), 'utf8')
        .replace(/\bapi:8080/g, '127.0.0.1:8082')
        .replace(/\b(?:llmgw|llmgw-serve|llmgw-serve-b|llmgw-web):[0-9]+/g, '127.0.0.1:9');
      writeFileSync(path.join(directory, 'default.conf'), source + `
server { listen 8082; location / {
  add_header X-Fixture-Uri $request_uri;
  add_header X-Fixture-Auth $http_authorization;
  return 200 'forwarded';
} }
`);
      docker('run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::80',
        '-v', `${directory}/default.conf:/etc/nginx/conf.d/default.conf:ro`, 'nginx:1.27-alpine');
      const port = Number(docker('port', name, '80/tcp').split(':').at(-1));
      const uri = '/api/video-agent/projects/owned-project/import-scenes';
      const mib = 1024 * 1024;
      assert.equal((await request(port, uri, 33 * mib)).status, 100);
      assert.equal((await request(port, `${uri}/?retry=1`, 301 * mib)).status, 100);
      assert.equal((await request(port, uri, 301 * mib + 1)).status, 413);
      assert.equal((await request(port, `${uri}-other`, 33 * mib)).status, 413);
      assert.equal((await request(port, '/api/other', 33 * mib)).status, 413);
      const response = await request(port, `${uri}?source=fixture`, 7, 'fixture');
      assert.equal(response.status, 200);
      assert.equal(response.headers['x-fixture-uri'], `${uri}?source=fixture`);
      assert.equal(response.headers['x-fixture-auth'], 'Bearer proxy-fixture');
    } finally {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
