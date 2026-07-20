export const QUICK_RECORD_DOUBLE_ACTIVATION_MS = 320;

export function isQuickRecordDoubleActivation(
  previousActivationAt: number | null,
  currentActivationAt: number,
): boolean {
  if (previousActivationAt === null) return false;
  const elapsed = currentActivationAt - previousActivationAt;
  return elapsed > 0 && elapsed <= QUICK_RECORD_DOUBLE_ACTIVATION_MS;
}
