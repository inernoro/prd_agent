export interface TaskScheduleProjectIdentity {
  id: string;
  slug?: string;
}

export function taskScheduleProjectReference(search: string): string {
  return new URLSearchParams(search).get('project')?.trim() || '';
}

export function resolveTaskScheduleProjectId(
  search: string,
  projects: readonly TaskScheduleProjectIdentity[],
): string {
  const requested = taskScheduleProjectReference(search);
  if (requested) {
    const match = projects.find((project) => project.id === requested || project.slug === requested);
    if (match) return match.id;
  }
  return projects[0]?.id || '';
}
