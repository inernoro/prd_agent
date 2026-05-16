import { Users, Crown } from 'lucide-react';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import type { SubmissionCreator } from '@/services/real/submissions';

interface Props {
  creators: SubmissionCreator[];
  selectedUserId: string | null;
  onSelect: (userId: string | null) => void;
  loading?: boolean;
}

const ITEM_WIDTH = 64;

/** Crown color for the top-3 creators (gold / silver / bronze) */
const RANK_CROWN: Record<number, string> = {
  0: '#FACC15',
  1: '#CBD5E1',
  2: '#D8975A',
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
        const crownColor = RANK_CROWN[index];
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
                padding: 2,
                background: active
                  ? 'linear-gradient(135deg, #818CF8 0%, #A78BFA 100%)'
                  : 'rgba(255,255,255,0.08)',
                boxShadow: active ? '0 0 14px rgba(129,140,248,0.4)' : 'none',
              }}
            >
              {crownColor && (
                <Crown
                  size={13}
                  fill={crownColor}
                  strokeWidth={1.5}
                  className="absolute left-1/2 -translate-x-1/2 pointer-events-none"
                  style={{
                    top: -10,
                    color: crownColor,
                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
                  }}
                />
              )}
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
              style={{ color: active ? '#A5B4FC' : 'rgba(255,255,255,0.5)' }}
            >
              {c.ownerUserName}
            </span>
          </button>
        );
      })}
    </div>
  );
}
