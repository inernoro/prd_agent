import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { listSubmissionCreators, type SubmissionCreator } from '@/services/real/submissions';

/**
 * Shared creator-filter state for the showcase galleries (homepage embed +
 * full-screen page). Owns the creators list, the selected creator, and the
 * stale-response guard so the race-condition fix lives in one place.
 *
 * Item fetching stays in the consumer (page sizes differ); the consumer reads
 * `selectedCreatorRef.current` inside its own `fetchItems`.
 */
export interface CreatorFilter {
  creators: SubmissionCreator[];
  creatorsLoading: boolean;
  selectedCreatorId: string | null;
  selectedCreatorRef: MutableRefObject<string | null>;
  fetchCreators: (contentType: string) => Promise<void>;
  selectCreator: (userId: string | null) => void;
  resetCreator: () => void;
}

export function useCreatorFilter(): CreatorFilter {
  const [creators, setCreators] = useState<SubmissionCreator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(false);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const selectedCreatorRef = useRef<string | null>(null);
  const creatorsFetchIdRef = useRef(0);

  const fetchCreators = useCallback(async (contentType: string) => {
    const myFetchId = ++creatorsFetchIdRef.current;
    setCreatorsLoading(true);
    try {
      const res = await listSubmissionCreators({ contentType: contentType || undefined });
      if (creatorsFetchIdRef.current !== myFetchId) return;
      if (res.success) setCreators(res.data.creators);
    } finally {
      if (creatorsFetchIdRef.current === myFetchId) setCreatorsLoading(false);
    }
  }, []);

  const selectCreator = useCallback((userId: string | null) => {
    setSelectedCreatorId(userId);
    selectedCreatorRef.current = userId;
  }, []);

  const resetCreator = useCallback(() => {
    setSelectedCreatorId(null);
    selectedCreatorRef.current = null;
  }, []);

  return {
    creators,
    creatorsLoading,
    selectedCreatorId,
    selectedCreatorRef,
    fetchCreators,
    selectCreator,
    resetCreator,
  };
}
