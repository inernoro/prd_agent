import { Users } from 'lucide-react';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import type { SubmissionCreator } from '@/services/real/submissions';

interface Props {
  creators: SubmissionCreator[];
  selectedUserId: string | null;
  onSelect: (userId: string | null) => void;
  loading?: boolean;
}

const ITEM_WIDTH = 64;

/** Colored ring for the top-3 creators: gold / silver / bronze */
const RANK_RING: Record<number, { ring: string; glow: string; label: string }> = {
  0: { ring: 'linear-gradient(135deg, #FDE68A 0%, #B45309 100%)', glow: 'color-mix(in srgb, var(--semantic-warning-text) 30%, transparent)', label: 'var(--semantic-warning-text)' },
  1: { ring: 'linear-gradient(135deg, #E5E7EB 0%, #64748B 100%)', glow: 'color-mix(in srgb, var(--semantic-neutral-text) 24%, transparent)', label: 'var(--semantic-neutral-text)' },
  2: { ring: 'linear-gradient(135deg, #E0A472 0%, #9A4F22 100%)', glow: 'color-mix(in srgb, var(--semantic-orange-text) 26%, transparent)', label: 'var(--semantic-orange-text)' },
};

/**
 * Horizontal row of circular creator avatars. Clicking a creator filters the
 * gallery to that author; the leading "全部" chip resets the filter.
 */
export function CreatorFilterRow({ creators, selectedUserId, onSelect, loading }: Props) {
  if (loading) {
    return (
      <div className="flex items-center gap-3 overflow-hidden" style={{ height: 72 }}>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-1.5 shrink-0" style={{ width: ITEM_WIDTH }}>
            <div
              className="w-11 h-11 rounded-full animate-pulse"
              style={{ background: 'var(--bg-card)' }}
            />
            <div
              className="h-2 rounded animate-pulse"
              style={{ width: 40, background: 'var(--bg-input)' }}
            />
          </div>
        ))}
      </div>
    );
  }

  if (creators.length === 0) return null;

  const allActive = !selectedUserId;

  return (
    <div
      className="nav-scroll-hidden flex items-center gap-3 overflow-x-auto pb-1"
      style={{ overscrollBehaviorX: 'contain' }}
    >
      {/* 全部 reset chip */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className="flex flex-col items-center gap-1.5 shrink-0 transition-all duration-200"
        style={{ width: ITEM_WIDTH }}
        aria-pressed={allActive}
      >
        <div
          className="w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200"
          style={{
            background: allActive
              ? 'var(--selection-bg)'
              : 'var(--bg-card)',
            border: allActive
              ? '2px solid var(--selection-border)'
              : '2px solid var(--border-subtle)',
            boxShadow: allActive ? 'var(--shadow-card-active)' : 'none',
          }}
        >
          <Users size={17} style={{ color: allActive ? 'var(--selection-text)' : 'var(--text-muted)' }} />
        </div>
        <span
          className="text-[11px] truncate w-full text-center"
          style={{ color: allActive ? 'var(--selection-text)' : 'var(--text-secondary)', fontWeight: allActive ? 600 : 500 }}
        >
          全部
        </span>
      </button>

      {creators.map((c, index) => {
        const active = selectedUserId === c.ownerUserId;
        const avatarUrl = resolveAvatarUrl({ avatarFileName: c.ownerAvatarFileName });
        const rank = RANK_RING[index];
        return (
          <button
            key={c.ownerUserId}
            type="button"
            onClick={() => onSelect(active ? null : c.ownerUserId)}
            title={`${c.ownerUserName} · ${c.submissionCount} 件作品`}
            className="flex flex-col items-center gap-1.5 shrink-0 transition-all duration-200"
            style={{ width: ITEM_WIDTH }}
            aria-pressed={active}
          >
            <div
              className="relative w-11 h-11 rounded-full transition-all duration-200"
              style={{
                padding: rank ? 2.5 : 2,
                background: active
                  ? 'var(--accent-primary)'
                  : rank
                    ? rank.ring
                    : 'var(--border-default)',
                boxShadow: active
                  ? 'var(--shadow-card-active)'
                  : rank
                    ? `0 0 12px ${rank.glow}`
                    : 'none',
              }}
            >
              <img
                src={avatarUrl}
                alt={c.ownerUserName}
                className="w-full h-full rounded-full object-cover"
                style={{ background: 'var(--bg-input)' }}
                loading="lazy"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK;
                }}
              />
            </div>
            <span
              className="text-[11px] truncate w-full text-center"
              style={{ color: active ? 'var(--selection-text)' : rank ? rank.label : 'var(--text-secondary)', fontWeight: active || rank ? 600 : 500 }}
            >
              {c.ownerUserName}
            </span>
          </button>
        );
      })}
    </div>
  );
}
