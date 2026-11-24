import { afterAll, afterEach, beforeEach } from 'vitest';
import { installEphemeralLoopbackFixture } from './ephemeral-loopback-fixture.js';
import { deploymentPhaseBudget, setDeploymentPhaseMemoryProvider } from '../../src/services/deployment-phase-budget.js';

const restoreEphemeralLoopbackFixture = installEphemeralLoopbackFixture();
afterAll(restoreEphemeralLoopbackFixture);

// 现有路由/容器用例模拟Docker；内存前提同样固定，不借宿主瞬时空闲内存放大测试期限。
// 实际容量等待、并发预留和恢复由deployment-phase-budget.test独立注入并断言。
beforeEach(() => setDeploymentPhaseMemoryProvider(() => 8192));
afterEach(() => {
  for (const reservation of deploymentPhaseBudget.memorySnapshot()) deploymentPhaseBudget.releaseMemory(reservation.key);
  setDeploymentPhaseMemoryProvider(null);
});
