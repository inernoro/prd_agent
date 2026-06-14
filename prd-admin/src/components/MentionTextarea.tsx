import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveAvatarUrl } from '@/lib/avatar';

export type MentionUser = {
  userId: string;
  displayName: string;
  username?: string;
  avatarFileName?: string | null;
};

/** 从评论正文提取已 @ 的用户 ID（按 displayName 精确匹配）。 */
export function extractMentionIds(text: string, users: MentionUser[]): string[] {
  const ids: string[] = [];
  const sorted = [...users].sort((a, b) => (b.displayName?.length ?? 0) - (a.displayName?.length ?? 0));
  for (const user of sorted) {
    const name = user.displayName?.trim();
    if (!name) continue;
    if (text.includes(`@${name}`) && !ids.includes(user.userId)) ids.push(user.userId);
  }
  return ids;
}

/** 根据光标位置解析当前 @ 检索词；无活跃 @ 时返回 null。 */
export function detectMentionQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const matched = before.match(/@([^\s@]*)$/);
  return matched ? matched[1] : null;
}

export function MentionTextarea({
  value,
  onChange,
  users,
  onMentionIdsChange,
  placeholder = '写下评论，输入 @ 提醒成员…',
  minHeight = 90,
  disabled = false,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  users: MentionUser[];
  onMentionIdsChange?: (ids: string[]) => void;
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(() => {
    if (mentionQuery === null) return [];
    const keyword = mentionQuery.trim().toLowerCase();
    return users
      .filter((user) => {
        const name = user.displayName?.toLowerCase() ?? '';
        const username = user.username?.toLowerCase() ?? '';
        if (!keyword) return true;
        return name.includes(keyword) || username.includes(keyword);
      })
      .slice(0, 8);
  }, [mentionQuery, users]);

  useEffect(() => {
    setActiveIndex(0);
  }, [mentionQuery, matches.length]);

  useEffect(() => {
    onMentionIdsChange?.(extractMentionIds(value, users));
  }, [onMentionIdsChange, users, value]);

  const syncMentionQuery = useCallback((text: string, caret: number) => {
    setMentionQuery(detectMentionQuery(text, caret));
  }, []);

  const pickMention = useCallback((user: MentionUser) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const name = user.displayName?.trim() || user.username || user.userId;
    const before = value.slice(0, caret).replace(/@([^\s@]*)$/, `@${name} `);
    const next = before + value.slice(caret);
    onChange(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = before.length;
      el.setSelectionRange(pos, pos);
    });
  }, [onChange, value]);

  const onValueChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    const caret = event.target.selectionStart ?? next.length;
    onChange(next);
    syncMentionQuery(next, caret);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pickMention(matches[activeIndex] ?? matches[0]);
        return;
      }
    }
    if (event.key === 'Escape' && mentionQuery !== null) {
      event.preventDefault();
      setMentionQuery(null);
    }
  };

  const showDropdown = mentionQuery !== null && matches.length > 0;

  return (
    <div className={`relative ${className}`}>
      {showDropdown && (
        <div
          className="absolute left-0 bottom-full z-20 mb-1 w-full max-w-sm overflow-hidden rounded-lg border border-white/15 bg-[#181a20] py-1 shadow-xl"
          role="listbox"
        >
          {matches.map((user, index) => (
            <button
              key={user.userId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickMention(user)}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                index === activeIndex ? 'bg-cyan-500/15 text-cyan-100' : 'text-white/85 hover:bg-white/5'
              }`}
            >
              <img
                src={resolveAvatarUrl({ avatarFileName: user.avatarFileName, username: user.username })}
                alt=""
                className="h-7 w-7 shrink-0 rounded-full border border-white/10 object-cover"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate">{user.displayName || user.username}</div>
                {user.username && user.username !== user.displayName && (
                  <div className="truncate text-[11px] text-white/40">{user.username}</div>
                )}
              </div>
              <span className="shrink-0 text-xs text-cyan-300/80">@{user.displayName || user.username}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={onValueChange}
        onKeyDown={onKeyDown}
        onClick={(event) => syncMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
        onKeyUp={(event) => syncMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
        placeholder={placeholder}
        className="w-full resize-y rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/30 focus:border-cyan-500/40 disabled:opacity-50"
        style={{ minHeight, lineHeight: 1.6 }}
      />
    </div>
  );
}
