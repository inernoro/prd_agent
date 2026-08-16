import {
  constants,
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function decodeStableSmokePrivateKey(encoded) {
  const value = String(encoded || '').trim();
  if (!value) return '';
  if (value.includes('BEGIN PRIVATE KEY')) return value;
  const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
  if (!decoded.includes('BEGIN PRIVATE KEY')) {
    throw new Error('稳定冒烟签名私钥格式无效');
  }
  return decoded;
}

export function buildStableSmokeCanonicalRequest({ method, path, timestamp, nonce, username, body }) {
  const bodyHash = createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
  return [
    String(method || '').toUpperCase(),
    String(path || ''),
    String(timestamp),
    String(nonce || ''),
    String(username || ''),
    bodyHash,
  ].join('\n');
}

export function buildStableSmokeSignatureHeaders({
  method,
  url,
  body,
  keyId,
  username,
  privateKey,
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomBytes(24).toString('base64url'),
}) {
  if (!keyId || !username || !privateKey) {
    throw new Error('稳定冒烟签名凭据未配置完整');
  }
  const path = new URL(url, 'https://stable-smoke.invalid').pathname;
  const canonical = buildStableSmokeCanonicalRequest({
    method,
    path,
    timestamp,
    nonce,
    username,
    body,
  });
  const signature = sign('sha256', Buffer.from(canonical, 'utf8'), {
    key: createPrivateKey(decodeStableSmokePrivateKey(privateKey)),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
  return {
    'X-Stable-Smoke-Key-Id': keyId,
    'X-Stable-Smoke-Timestamp': String(timestamp),
    'X-Stable-Smoke-Nonce': nonce,
    'X-Stable-Smoke-Signature': signature,
  };
}

export function buildStableSmokeAuthHeaders(options) {
  if (options.aiAccessKey) {
    return {
      'X-AI-Access-Key': options.aiAccessKey,
      'X-AI-Impersonate': options.username,
    };
  }
  return buildStableSmokeSignatureHeaders(options);
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || '' : '';
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const headers = buildStableSmokeSignatureHeaders({
    method: readArg(argv, '--method') || 'POST',
    url: readArg(argv, '--url'),
    body: readArg(argv, '--body'),
    keyId: process.env.STABLE_SMOKE_SIGNING_KEY_ID || '',
    username: readArg(argv, '--username'),
    privateKey: process.env.STABLE_SMOKE_SIGNING_PRIVATE_KEY || '',
  });
  process.stdout.write(`${JSON.stringify(headers)}\n`);
}
