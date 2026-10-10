import { createHash } from 'node:crypto';
import type { BranchEntry, BuildProfile, ServiceState } from '../types.js';

/** Candidate identity is independent of the serving instance; full identity remains in Docker labels. */
export function candidateRuntimeIdentity(branchId: string, profileId: string, runId: string) {
  for (const value of [branchId, profileId, runId]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error('candidate_identity: invalid owner identity');
  }
  const digest = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
  return { containerName: `cds-candidate-${digest([branchId, profileId, runId])}`,
    networkName: `cds-candidate-net-${digest([branchId, runId])}` };

}

/** A private service graph. It is not inserted into StateService or published as the serving branch. */
export function createCandidateRuntime(entry: BranchEntry, profiles: readonly BuildProfile[], runId: string,
  allocatePort: (reserved: ReadonlySet<number>) => number): BranchEntry {
  const target = entry.deploymentTargetSha || entry.githubCommitSha || '';
  if (!/^[0-9a-f]{40}$/.test(target)) throw new Error('candidate_target: full target SHA required');
  if (profiles.length === 0) throw new Error('candidate_graph: nonempty service graph required');
  const identities = new Map<string, ReturnType<typeof candidateRuntimeIdentity>>();
  const servingNames = new Set(Object.values(entry.services).map(service => service.containerName));
  for (const profile of profiles) {
    if (identities.has(profile.id)) throw new Error('candidate_identity: duplicate profile');
    const identity = candidateRuntimeIdentity(entry.id, profile.id, runId);
    if (servingNames.has(identity.containerName)) throw new Error('candidate_identity: run already serves traffic');
    identities.set(profile.id, identity);
  }
  const reserved = new Set(Object.values(entry.services).map(service => service.hostPort));
  const services: Record<string, ServiceState> = Object.create(null);
  for (const profile of profiles) {
    const { containerName } = identities.get(profile.id)!;
    const port = allocatePort(reserved);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || reserved.has(port)) throw new Error('candidate_port: unreserved port required');
    reserved.add(port);
    services[profile.id] = { profileId: profile.id, containerName, hostPort: port, status: 'idle' };
  }
  return { ...entry, githubCommitSha: target, deploymentTargetSha: target, services, status: 'building' };
}
