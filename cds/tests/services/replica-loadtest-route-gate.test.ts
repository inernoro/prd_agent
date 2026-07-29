/**
 * 压测端点与既有磁盘刹车中间件的边界。
 *
 * 复制集路由器上那道 `requestGrowsDisk` 中间件只拦「会让磁盘增长」的动作。压测
 * 不写盘（它烧的是 CPU / 连接数），所以**不该**被那道通用中间件按路径误伤——
 * 但它必须被压测服务自己的磁盘闸拒绝，且理由要说清楚是磁盘的事。两件事分开测：
 * 前者防「拦错」（磁盘紧张时连诊断都做不了），后者防「漏拦」（恢复期还去加压）。
 */
import { describe, expect, it } from 'vitest';
import { isDiskGrowingReplicaAction, requestGrowsDisk } from '../../src/routes/replica-sets.js';

describe('压测端点不被通用磁盘中间件按路径误伤', () => {
  it('压测的四个端点都不属于「会让磁盘增长」的动作', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-loadtests')).toBe(false);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-loadtests/lt-1')).toBe(false);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-loadtests/lt-1/cancel')).toBe(false);
    expect(requestGrowsDisk('/branches/b1/replica-loadtests', { profileId: 'api' })).toBe(false);
  });

  it('不会被 replica-plans 的规则误命中（两者只差一个词）', () => {
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-plans')).toBe(true);
    expect(isDiskGrowingReplicaAction('/branches/b1/replica-loadtests/')).toBe(false);
  });
});
