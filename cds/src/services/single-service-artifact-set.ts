import type { BuildProfile } from '../types.js';

/** Exact single-service deployment must admit its complete declared application dependency closure. */
export function singleServiceArtifactSet(profiles: readonly BuildProfile[], profileId: string,
  availableInfraIds: ReadonlySet<string>): BuildProfile[] {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const root = byId.get(profileId);
  if (!root || byId.size !== profiles.length) throw new Error('artifact_dependency_graph: unique target profiles required');
  const scope = root.projectId || 'default';
  const visiting = new Set<string>(); const completed = new Set<string>(); const result: BuildProfile[] = [];
  const visit = (id: string) => {
    if (completed.has(id)) return;
    if (visiting.has(id)) throw new Error('artifact_dependency_cycle: required service dependencies contain a cycle');
    const profile = byId.get(id);
    if (!profile) {
      if (availableInfraIds.has(id)) return;
      throw new Error(`artifact_dependency_unavailable: ${id}`);
    }
    if ((profile.projectId || 'default') !== scope) throw new Error(`artifact_dependency_scope: ${id}`);
    if (!profile.prebuiltImage || profile.prebuiltCommitPolicy !== 'exact') throw new Error(`artifact_dependency_mode: ${id} requires an exact prebuilt declaration`);
    if (visiting.size + completed.size >= 512) throw new Error('artifact_dependency_limit');
    visiting.add(id);
    for (const dependency of profile.dependsOn || []) visit(dependency);
    visiting.delete(id); completed.add(id); result.push(profile);
  };
  visit(profileId); return result;
}
