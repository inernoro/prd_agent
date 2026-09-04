import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPreflightBlockers } from '../authorization-health-preflight.mjs';

test('授权预检将主应用 RSA 身份失败归入产品身份阻断', () => {
  const result = classifyPreflightBlockers([
    'CDS 环境主应用自动化身份校验未通过',
    'CDS 环境模型网关自动化身份校验未通过（AUTH_STABLE_SMOKE_SIGNATURE_INVALID）',
    'api 尚未切换到运行时目标镜像',
  ]);

  assert.deepEqual(result.productIdentityBlockers, ['CDS 环境主应用自动化身份校验未通过']);
  assert.equal(result.gatewayIdentityBlockers.length, 1);
  assert.equal(result.deploymentBlockers.length, 1);
});

test('授权预检不把无关诊断误判为身份阻断', () => {
  const result = classifyPreflightBlockers(['CDS 权威预览地址读取失败']);

  assert.deepEqual(result.productIdentityBlockers, []);
  assert.deepEqual(result.gatewayIdentityBlockers, []);
  assert.deepEqual(result.deploymentBlockers, []);
});
