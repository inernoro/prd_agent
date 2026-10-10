/** A lifecycle observation cannot rewrite an immutable successor instance. */
export function canApplyDockerLifecycleState(
  servingContainerId: string | undefined,
  event: { containerId?: string; stateSyncEligible?: boolean },
): boolean {
  if (event.stateSyncEligible === false) return false;
  // Legacy services without IDs remain compatible, but do not gain an identity proof.
  if (servingContainerId === undefined) return true;
  return /^[a-f0-9]{64}$/.test(servingContainerId) && servingContainerId === event.containerId;
}
