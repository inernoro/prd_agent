import type { DesignDeliveryFile, DesignVersion } from '../shared/design-workspace.js';

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]));
  });
}

function netChanges<T extends object>(before: readonly T[], after: readonly T[], key: keyof T) {
  const left = new Map(before.map(row => [String(row[key]), row]));
  const right = new Map(after.map(row => [String(row[key]), row]));
  const added: T[] = [];
  const removed: T[] = [];
  const changed: Array<Partial<T> & { fields: string[]; from: Partial<T>; to: Partial<T> }> = [];
  const pick = (row: T, fields: string[]) => Object.fromEntries(fields.map(field => [field, row[field as keyof T]])) as Partial<T>;
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const previous = left.get(id);
    const current = right.get(id);
    if (!previous) { added.push(current!); continue; }
    if (!current) { removed.push(previous); continue; }
    const fields = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()
      .filter(field => canonical(previous[field as keyof T] ?? null) !== canonical(current[field as keyof T] ?? null));
    if (fields.length) changed.push({ ...pick(current, [String(key)]), fields, from: pick(previous, fields), to: pick(current, fields) });
  }
  return { added, removed, changed };
}

function packageFiles(version: DesignVersion): Array<Pick<DesignDeliveryFile, 'path' | 'sha256'>> {
  // The generated diff index describes the release; including it would compare the diff to itself.
  return (version.delivery?.files ?? []).filter(file => !file.path.startsWith('changes/')).map(({ path, sha256 }) => ({ path, sha256 }));
}

export function compareDesignVersions(from: DesignVersion, to: DesignVersion) {
  const files = netChanges(packageFiles(from), packageFiles(to), 'path');
  const metadata = ({ version, title, sourceCommit, sha256 }: DesignVersion) => ({ version, title, sourceCommit, sha256 });
  return {
    fromVersion: from.version, toVersion: to.version,
    direction: from.version < to.version ? 'upgrade' : from.version > to.version ? 'rollback' : 'same',
    from: metadata(from), to: metadata(to),
    screens: netChanges(from.screens, to.screens, 'id'),
    acceptance: netChanges(from.acceptance, to.acceptance, 'id'),
    files,
    sourcePaths: [...files.added, ...files.removed, ...files.changed].flatMap(row => row.path?.startsWith('src/') ? [row.path] : []).sort(),
  };
}
