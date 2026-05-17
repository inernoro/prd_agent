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
  0: { ring: 'linear-gradient(135deg, #FDE68A 0%, #F59E0B 100%)', glow: 'rgba(245,158,11,0.55)', label: '#FBBF24' },
  1: { ring: 'linear-gradient(135deg, #E5E7EB 0%, #94A3B8 100%)', glow: 'rgba(148,163,184,0.5)', label: '#CBD5E1' },
  2: { ring: 'linear-gradient(135deg, #E0A472 0%, #B26B33 100%)', glow: 'rgba(178,107,51,0.5)', label: '#D8975A' },
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
              style={{ background: 'rgba(255,255,255,0.05)' }}
            />
            <div
              className="h-2 rounded animate-pulse"
              style={{ width: 40, background: 'rgba(255,255,255,0.04)' }}
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
              ? 'linear-gradient(135deg, rgba(99,102,241,0.35) 0%, rgba(168,85,247,0.3) 100%)'
              : 'rgba(255,255,255,0.06)',
            border: allActive
              ? '2px solid rgba(129,140,248,0.7)'
              : '2px solid rgba(255,255,255,0.08)',
            boxShadow: allActive ? '0 0 14px rgba(129,140,248,0.35)' : 'none',
          }}
        >
          <Users size={17} style={{ color: allActive ? '#C7D2FE' : 'rgba(255,255,255,0.5)' }} />
        </div>
        <span
          className="text-[11px] truncate w-full text-center"
          style={{ color: allActive ? '#A5B4FC' : 'rgba(255,255,255,0.45)' }}
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
                  ? 'linear-gradient(135deg, #818CF8 0%, #A78BFA 100%)'
                  : rank
                    ? rank.ring
                    : 'rgba(255,255,255,0.08)',
                boxShadow: active
                  ? '0 0 14px rgba(129,140,248,0.4)'
                  : rank
                    ? `0 0 12px ${rank.glow}`
                    : 'none',
              }}
            >
              <img
                src={avatarUrl}
                alt={c.ownerUserName}
                className="w-full h-full rounded-full object-cover"
                style={{ background: '#0a0a0f' }}
                loading="lazy"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK;
                }}
              />
            </div>
            <span
              className="text-[11px] truncate w-full text-center"
              style={{ color: active ? '#A5B4FC' : rank ? rank.label : 'rgba(255,255,255,0.5)' }}
            >
              {c.ownerUserName}
            </span>
          </button>
        );
      })}
    </div>
  );
}
