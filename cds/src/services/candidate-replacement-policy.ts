import type { BuildProfile } from '../types.js';
import { inferServiceRole } from './service-graph.js';

/** Safe defaults; a string declaration cannot prove worker isolation or concurrent volume safety. */
export function resolveCandidateReplacement(profile: BuildProfile, actualWritableMounts: readonly string[]) {
  if (!profile.prebuiltImage || profile.prebuiltCommitPolicy !== 'exact' || !/^[a-f0-9]{40}$/.test(profile.preparedCommitSha || '') ||
    !/^sha256:[a-f0-9]{64}$/.test(profile.preparedArtifactId || '')) throw new Error('replacement_artifact: complete prepared exact artifact required');
  if (profile.replacementStrategy && !['parallel', 'stop-and-restore'].includes(profile.replacementStrategy)) throw new Error('replacement_strategy: unknown strategy');
  const reasons: string[] = [];
  if (inferServiceRole(profile).role === 'worker') reasons.push('single-consumer');
  if (profile.cacheMounts?.length || actualWritableMounts.length) reasons.push('writable-volume');
  if (profile.replacementStrategy === 'parallel' && reasons.length) throw new Error('replacement_constraint: parallel safety has not been proved');
  return { strategy: reasons.length || profile.replacementStrategy === 'stop-and-restore'
    ? 'stop-and-restore' as const : 'parallel' as const, reasons };
}
