import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPreflightBlockers,
  retainRunnerFailure,
} from '../authorization-health-preflight.mjs';

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

test('授权预检保留所有非身份类部署阻断', () => {
  const blockers = [
    'CDS 权威预览地址读取失败',
    '分支状态为 stopped',
    'CDS 未返回任何业务服务',
    'api 未运行',
  ];
  const result = classifyPreflightBlockers(blockers);

  assert.deepEqual(result.productIdentityBlockers, []);
  assert.deepEqual(result.gatewayIdentityBlockers, []);
  assert.deepEqual(result.deploymentBlockers, blockers);
});

test('授权预检运行器异常退出时补充脱敏阻断', () => {
  assert.deepEqual(retainRunnerFailure([], 1), [
    '授权预检运行器异常退出，未返回可分类阻断；请检查运行器日志与本地配置权限',
  ]);
  assert.deepEqual(retainRunnerFailure(['分支状态为 stopped'], 1), ['分支状态为 stopped']);
  assert.deepEqual(retainRunnerFailure([], 0), []);
});
