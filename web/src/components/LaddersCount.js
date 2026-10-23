// Open ladder follow-ups, for Today's "Needs you" (desk only). Kept apart
// from the ladder screens so Today loads none of them.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';

export function useFollowupCount(enabled = true) {
  const q = useQuery({
    queryKey: ['ladders', 'followups', 'count'],
    queryFn: () => apiGet('/ladders/followups/count'),
    enabled,
  });
  return { n: Number(q.data?.open) || 0, pending: enabled && q.isPending };
}
