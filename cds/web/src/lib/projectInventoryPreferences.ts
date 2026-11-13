export interface ProjectInventoryPreferences {
  view: 'grid' | 'list';
  pinnedProjectIds: string[];
}

const STORAGE_KEY = 'cds:project-inventory-preferences:v1';

/** Only presentation preferences live here; project state and permissions stay on the server. */
export function readProjectInventoryPreferences(): ProjectInventoryPreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    return {
      view: value?.view === 'list' ? 'list' : 'grid',
      pinnedProjectIds: Array.isArray(value?.pinnedProjectIds)
        ? [...new Set<string>(value.pinnedProjectIds.filter((id: unknown) => typeof id === 'string' && id.length > 0))] : [],
    };
  } catch {
    return { view: 'grid', pinnedProjectIds: [] };
  }
}

export function writeProjectInventoryPreferences(preferences: ProjectInventoryPreferences): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}
