import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import {
  buildStableSmokeCanonicalRequest,
  buildStableSmokeSignatureHeaders,
} from '../stable-smoke-signature.mjs';

test('签名请求绑定方法、路径、账号、正文、时间戳与一次性随机数', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const body = JSON.stringify({ returnUrl: '/', expiresInSeconds: 60 });
  const timestamp = 1_786_547_200;
  const nonce = 'nonce_for_test_1234567890';
  const headers = buildStableSmokeSignatureHeaders({
    method: 'POST',
    url: 'https://map.ebcone.net/api/v1/auth/synthetic/ticket?ignored=true',
    body,
    keyId: 'test-key',
    username: 'stsmk_prod',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    timestamp,
    nonce,
  });
  const canonical = buildStableSmokeCanonicalRequest({
    method: 'POST',
    path: '/api/v1/auth/synthetic/ticket',
    timestamp,
    nonce,
    username: 'stsmk_prod',
    body,
  });
  const verifyOptions = {
    key: publicKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  };

  assert.equal(headers['X-Stable-Smoke-Key-Id'], 'test-key');
  assert.equal(headers['X-Stable-Smoke-Timestamp'], String(timestamp));
  assert.equal(headers['X-Stable-Smoke-Nonce'], nonce);
  assert.equal(verify(
    'sha256',
    Buffer.from(canonical),
    verifyOptions,
    Buffer.from(headers['X-Stable-Smoke-Signature'], 'base64'),
  ), true);
  assert.equal(verify(
    'sha256',
    Buffer.from(canonical.replace('stsmk_prod', 'admin')),
    verifyOptions,
    Buffer.from(headers['X-Stable-Smoke-Signature'], 'base64'),
  ), false);
});
