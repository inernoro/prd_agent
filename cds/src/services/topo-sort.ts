// ── Topological Sort by Layers ──
// Pure function: given items with dependency edges, group them into layers
// where layer 0 has no unresolved deps, layer 1 depends only on layer 0, etc.

export interface TopoLayer<T> {
  layer: number;
  items: T[];
}

export interface TopoResult<T> {
  layers: TopoLayer<T>[];
  /** Items whose deps reference unknown IDs (not in items or resolvedIds) — placed in layer 0 with warning */
  warnings: string[];
}

/**
 * Topological sort by layers (Kahn's algorithm variant).
 *
 * @param items       All items to sort
 * @param getId       Extract unique ID from item
 * @param getDeps     Extract dependency IDs from item
 * @param resolvedIds IDs considered already satisfied (e.g., running infra services)
 * @returns Layers ordered 0..N. Items within a layer can start in parallel.
 * @throws Error if a dependency cycle is detected
 */
export function topoSortLayers<T>(
  items: T[],
  getId: (item: T) => string,
  getDeps: (item: T) => string[],
  resolvedIds: Set<string> = new Set(),
): TopoResult<T> {
  if (items.length === 0) return { layers: [], warnings: [] };

  const warnings: string[] = [];
  const itemMap = new Map<string, T>();
  for (const item of items) {
    itemMap.set(getId(item), item);
  }

  // Build in-degree map: only count deps that reference other items in the list
  // Deps referencing resolvedIds or unknown IDs are considered pre-satisfied
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // depId → [itemIds that depend on it]

  for (const item of items) {
    const id = getId(item);
    inDegree.set(id, 0);
  }

  for (const item of items) {
    const id = getId(item);
    const deps = getDeps(item);
    for (const dep of deps) {
      if (resolvedIds.has(dep)) continue; // pre-satisfied (infra service already running)
      if (!itemMap.has(dep)) {
        // Unknown dep — warn but treat as satisfied
        warnings.push(`${id} depends on "${dep}" which is not a known profile or running infra service`);
        continue;
      }
      inDegree.set(id, (inDegree.get(id) || 0) + 1);
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(id);
    }
  }

  // Process layer by layer
  const layers: TopoLayer<T>[] = [];
  const remaining = new Set(itemMap.keys());

  while (remaining.size > 0) {
    // Collect items with in-degree 0
    const currentLayer: T[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) || 0) === 0) {
        currentLayer.push(itemMap.get(id)!);
      }
    }

    if (currentLayer.length === 0) {
      // All remaining items have non-zero in-degree → cycle detected
      const cycleIds = Array.from(remaining).join(', ');
      throw new Error(`Dependency cycle detected among: ${cycleIds}`);
    }

    layers.push({ layer: layers.length, items: currentLayer });

    // Remove processed items and decrement dependents' in-degree
    for (const item of currentLayer) {
      const id = getId(item);
      remaining.delete(id);
      for (const depId of dependents.get(id) || []) {
        inDegree.set(depId, (inDegree.get(depId) || 0) - 1);
      }
    }
  }

  return { layers, warnings };
}
