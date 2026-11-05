import { useEffect, useState } from 'react';
import { readUiPreference, writeUiPreference } from '@/lib/uiPreferences';

function readOption<T extends string>(key: string, options: readonly { value: T }[], fallback: T): T {
  const saved = readUiPreference(key, fallback);
  return options.find(option => option.value === saved)?.value ?? fallback;
}

/** 两页共用读写与失效值回退，key 隔离以保留各页面自己的显示偏好。 */
export function useListDisplayPreferences<TSort extends string, TSize extends string>({
  sortKey, cardSizeKey, sortOptions, cardSizeOptions, defaultSort, defaultCardSize,
}: {
  sortKey: string;
  cardSizeKey: string;
  sortOptions: readonly { value: TSort }[];
  cardSizeOptions: readonly { value: TSize }[];
  defaultSort: TSort;
  defaultCardSize: TSize;
}) {
  const [sort, setSort] = useState(() => readOption(sortKey, sortOptions, defaultSort));
  const [cardSize, setCardSize] = useState(() => readOption(cardSizeKey, cardSizeOptions, defaultCardSize));
  useEffect(() => { writeUiPreference(sortKey, sort); }, [sortKey, sort]);
  useEffect(() => { writeUiPreference(cardSizeKey, cardSize); }, [cardSizeKey, cardSize]);
  return { sort, setSort, cardSize, setCardSize };
}
