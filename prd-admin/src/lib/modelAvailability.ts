/** 选择器共享网关的恢复资格，不能把等待试探的线路永久锁在界面之外。 */
export function isModelAvailableForRequest(model: {
  healthStatus: string;
  isRecoveryProbeAvailable?: boolean;
}): boolean {
  return model.healthStatus === 'Healthy'
    || model.healthStatus === 'Degraded'
    || (model.healthStatus === 'Unavailable' && model.isRecoveryProbeAvailable === true);
}
