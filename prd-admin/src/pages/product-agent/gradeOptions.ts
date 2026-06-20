import { useCallback, useEffect, useState } from 'react';
import { listGradeOptions } from '@/services/real/productAgent';
import type { GradeDimension, GradeEntityType, ProductGradeOption } from './types';

/**
 * 通用等级目录 hook（优先级 / 严重程度，按对象类型）。
 * 仿 requirementTypes.ts 写法，但按 (dimension, entityType) 组合查询，附带 loading。
 */
export function useGradeOptions(dimension: GradeDimension, entityType: GradeEntityType) {
  const [options, setOptions] = useState<ProductGradeOption[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async (): Promise<ProductGradeOption[]> => {
    setLoading(true);
    try {
      const res = await listGradeOptions({ dimension, entityType });
      const items = res.success ? res.data.items : [];
      setOptions(items);
      return items;
    } finally {
      setLoading(false);
    }
  }, [dimension, entityType]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { options, reload, loading };
}
