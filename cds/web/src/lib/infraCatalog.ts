/**
 * Infra catalog client — reads the backend SSOT (GET /api/infra/catalog) so the
 * frontend never hard-codes infra images / ports / connection-var names.
 *
 * Backend SSOT: cds/src/services/infra-catalog.ts -> getInfraCatalogPublic().
 * Adding a new infra type there auto-surfaces it in every picker that uses this lib.
 *
 * A static fallback keeps the picker usable if the endpoint is briefly unavailable
 * (graceful degradation per .claude/rules/no-rootless-tree.md — expose, don't crash).
 */
import { useEffect, useState } from 'react';
import { apiRequest } from './api';

export interface InfraCatalogItem {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  description: string;
  dockerImage: string;
  containerPort: number;
  hasPersistence: boolean;
  schemaful: boolean;
  /** User may customise the database name (default "app"). */
  supportsDbName?: boolean;
  /** Initialization SQL can be configured + run against this store. */
  supportsInitSql?: boolean;
  /** App-visible connection env var names this preset injects (e.g. ['DATABASE_URL']). */
  connectionEnvKeys: string[];
}

export interface InfraCatalogGroup {
  category: string;
  label: string;
  items: InfraCatalogItem[];
}

const CATEGORY_ORDER = ['database', 'cache', 'queue', 'search', 'storage', 'config', 'other'];

/** Minimal fallback (the historical core 5) used only if the endpoint is unreachable. */
export const INFRA_CATALOG_FALLBACK: InfraCatalogItem[] = [
  { id: 'mongodb', name: 'MongoDB', category: 'database', categoryLabel: '数据库', description: '文档型数据库，自动注入 MONGODB_URL。', dockerImage: 'mongo:7', containerPort: 27017, hasPersistence: true, schemaful: false, connectionEnvKeys: ['MONGODB_URL'] },
  { id: 'postgres', name: 'PostgreSQL', category: 'database', categoryLabel: '数据库', description: '关系型数据库，自动注入 DATABASE_URL。', dockerImage: 'postgres:16-alpine', containerPort: 5432, hasPersistence: true, schemaful: true, connectionEnvKeys: ['DATABASE_URL', 'POSTGRES_URL'] },
  { id: 'mysql', name: 'MySQL', category: 'database', categoryLabel: '数据库', description: '关系型数据库，自动注入 DATABASE_URL。', dockerImage: 'mysql:8', containerPort: 3306, hasPersistence: true, schemaful: true, connectionEnvKeys: ['DATABASE_URL', 'MYSQL_URL'] },
  { id: 'redis', name: 'Redis', category: 'cache', categoryLabel: '缓存', description: '内存键值缓存，自动注入 REDIS_URL。', dockerImage: 'redis:7-alpine', containerPort: 6379, hasPersistence: true, schemaful: false, connectionEnvKeys: ['REDIS_URL'] },
  { id: 'rabbitmq', name: 'RabbitMQ', category: 'queue', categoryLabel: '消息队列', description: 'AMQP 消息队列，自动注入 RABBITMQ_URL。', dockerImage: 'rabbitmq:3-management-alpine', containerPort: 5672, hasPersistence: true, schemaful: false, connectionEnvKeys: ['RABBITMQ_URL'] },
];

export async function fetchInfraCatalog(signal?: AbortSignal): Promise<InfraCatalogItem[]> {
  try {
    const res = await apiRequest<{ catalog: InfraCatalogItem[] }>('/api/infra/catalog', { signal });
    return Array.isArray(res?.catalog) && res.catalog.length > 0 ? res.catalog : INFRA_CATALOG_FALLBACK;
  } catch {
    return INFRA_CATALOG_FALLBACK;
  }
}

export function groupInfraCatalog(items: InfraCatalogItem[]): InfraCatalogGroup[] {
  const byCategory = new Map<string, InfraCatalogItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) || [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  const groups: InfraCatalogGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const list = byCategory.get(category);
    if (list && list.length > 0) groups.push({ category, label: list[0].categoryLabel, items: list });
  }
  // Surface any categories not in the known order (forward-compatible).
  for (const [category, list] of byCategory) {
    if (!CATEGORY_ORDER.includes(category)) groups.push({ category, label: list[0].categoryLabel, items: list });
  }
  return groups;
}

/** React hook: fetch the catalog once on mount, fall back to the static list. */
export function useInfraCatalog(): { items: InfraCatalogItem[]; groups: InfraCatalogGroup[]; loading: boolean } {
  const [items, setItems] = useState<InfraCatalogItem[]>(INFRA_CATALOG_FALLBACK);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetchInfraCatalog(controller.signal)
      .then((list) => {
        if (active) {
          setItems(list);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  return { items, groups: groupInfraCatalog(items), loading };
}
