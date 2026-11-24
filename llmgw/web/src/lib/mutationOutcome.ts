/** Only an endpoint-audited rejection can establish that this attempt did not write.
 * Unknown/new codes, timeouts and post-write failures must be reconciled before retry. */
export function mutationOutcomeUnknown(code?: string, knownRejectedCodes: readonly string[] = []) {
  return !code || !knownRejectedCodes.includes(code);
}
