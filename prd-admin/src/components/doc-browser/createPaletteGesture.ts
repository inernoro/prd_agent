export const CREATE_PALETTE_DOUBLE_ACTIVATION_MS = 320;

export function isCreatePaletteDoubleActivation(
  previousActivationAt: number | null,
  currentActivationAt: number,
): boolean {
  if (previousActivationAt === null) return false;
  const elapsed = currentActivationAt - previousActivationAt;
  return elapsed > 0 && elapsed <= CREATE_PALETTE_DOUBLE_ACTIVATION_MS;
}
