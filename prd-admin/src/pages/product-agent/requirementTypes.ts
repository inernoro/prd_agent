import { useEffect, useState } from 'react';
import { listRequirementTypes } from '@/services/real/productAgent';
import type { RequirementType } from './types';

let cache: RequirementType[] | null = null;
const subscribers = new Set<(items: RequirementType[]) => void>();

export async function refreshRequirementTypes(): Promise<RequirementType[]> {
  const res = await listRequirementTypes();
  if (res.success) {
    cache = res.data.items;
    subscribers.forEach((fn) => fn(cache!));
  }
  return cache ?? [];
}

export function useRequirementTypes() {
  const [types, setTypes] = useState<RequirementType[]>(cache ?? []);
  useEffect(() => {
    const sub = (items: RequirementType[]) => setTypes(items);
    subscribers.add(sub);
    if (cache) setTypes(cache);
    else void refreshRequirementTypes();
    return () => {
      subscribers.delete(sub);
    };
  }, []);
  return { types, reload: refreshRequirementTypes };
}
