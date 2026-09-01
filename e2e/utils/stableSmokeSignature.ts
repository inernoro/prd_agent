import {
  constants,
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto';

function decodePrivateKey(encoded: string) {
  const value = encoded.trim();
  if (value.includes('BEGIN PRIVATE KEY')) return value;
  const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
  if (!decoded.includes('BEGIN PRIVATE KEY')) throw new Error('稳定冒烟签名私钥格式无效');
  return decoded;
}

export function buildStableSmokeAuthHeaders(options: {
  method: string;
  url: string;
  body: string;
  username: string;
  aiAccessKey?: string;
  keyId?: string;
  privateKey?: string;
}): Record<string, string> {
  if (!options.keyId || !options.privateKey) {
    if (!options.aiAccessKey) throw new Error('稳定冒烟认证凭据未配置完整');
    return {
      'X-AI-Access-Key': options.aiAccessKey,
      'X-AI-Impersonate': options.username,
    };
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(24).toString('base64url');
  const path = new URL(options.url, 'https://stable-smoke.invalid').pathname;
  const bodyHash = createHash('sha256').update(options.body, 'utf8').digest('hex');
  const canonical = [
    options.method.toUpperCase(),
    path,
    timestamp,
    nonce,
    options.username,
    bodyHash,
  ].join('\n');
  const signature = sign('sha256', Buffer.from(canonical, 'utf8'), {
    key: createPrivateKey(decodePrivateKey(options.privateKey)),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
  return {
    'X-Stable-Smoke-Key-Id': options.keyId,
    'X-Stable-Smoke-Timestamp': String(timestamp),
    'X-Stable-Smoke-Nonce': nonce,
    'X-Stable-Smoke-Signature': signature,
  };
}
