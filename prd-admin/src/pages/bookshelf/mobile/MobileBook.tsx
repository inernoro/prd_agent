/**
 * 手机档 · 一本书（第三级页面）。
 *
 * 这一屏是藏书阁改版的核心：在它之前，点开一本书看到的是「书名 + 作者 + 一句话收获」
 * 再加一个让用户自己写心得的输入框 —— 用户点两下发现没东西读是必然的，
 * 里面本来就只有索引、没有内容。
 *
 * 为什么是独立一屏而不是书卡展开区：精读稿一两千字，塞进列表行里的折叠区，
 * 读到一半想回去看目录得先滚过整篇。它是「一篇文章」，就该有自己的一屏。
 *
 * 生成是按需的：第一个点进这本书的人触发，生成完落库，之后所有人读同一篇。
 * 生成期间逐字流式渲染（规则 #6：静止的「加载中」超过 2 秒即为体验缺陷），
 * 并且写明正在用哪个模型（`ai-model-visibility`）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AS_TYPE, AS_SPACE } from '@/lib/appStoreTokens';
import { StreamingText } from '@/components/streaming/StreamingText';
import { DigestMarkdown } from '../DigestMarkdown';
import { getBookDigest, streamBookDigest } from '@/services/real/bookshelf';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import type { BookEntry, Volume, Track } from '@/lib/bookshelf/types';
import { Eyebrow, GroupCard, NavBar, Pill, asStyle, GUTTER, BOTTOM_GAP } from './parts';

const TRACK_LABEL: Record<Track, string> = { dev: '开发', pm: '产品', both: '通用' };
const LEVEL_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '硬骨头' };

type Phase = 'loading' | 'generating' | 'ready' | 'failed';

export function MobileBook({
  book,
  volume,
  skin,
  onBack,
}: {
  book: BookEntry;
  volume: Volume;
  skin: { fg: string; box: string };
  onBack: () => void;
}) {
  const readBookIds = useBookshelfStore((s) => s.readBookIds);
  const toggleRead = useBookshelfStore((s) => s.toggleRead);
  const bookNotes = useBookshelfStore((s) => s.bookNotes);
  const setNote = useBookshelfStore((s) => s.setNote);

  const read = readBookIds.includes(book.id);
  const [phase, setPhase] = useState<Phase>('loading');
  const [text, setText] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [citedRules, setCitedRules] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState(bookNotes[book.id] ?? '');

  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  const run = useCallback(async (force: boolean) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('generating');
    setText('');
    setError('');
    setElapsed(0);

    const res = await streamBookDigest({
      bookId: book.id,
      force,
      signal: ac.signal,
      onEvent: (evt) => {
        if (!aliveRef.current) return;
        if (evt.type === 'cached') {
          setText(evt.content);
          setModel(evt.model ?? null);
          setCitedRules(evt.citedRules ?? []);
          setPhase('ready');
        } else if (evt.type === 'start') {
          setModel(evt.model ?? null);
        } else if (evt.type === 'text') {
          setText((prev) => prev + evt.content);
        } else if (evt.type === 'done') {
          setCitedRules(evt.citedRules ?? []);
          setPhase('ready');
        } else if (evt.type === 'error') {
          setError(evt.message);
          setPhase('failed');
        }
      },
    });
    if (!aliveRef.current) return;
    if (!res.success) {
      setError(res.errorMessage || '连接断了，稿子没能取回来');
      setPhase('failed');
    }
  }, [book.id]);

  /* 进这一屏先问库里有没有；没有才触发生成，避免每次点开都烧一次 */
  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    void (async () => {
      const res = await getBookDigest(book.id);
      if (cancelled || !aliveRef.current) return;
      // stale = 这篇是旧版提示词写的。不认它就等于 stale 这个字段白算一场：
      // 后端已经改成「版本对不上就不复用」，前端这里再吃一次缓存，两边口径就分裂了。
      if (res.success && res.data?.exists && res.data.content && !res.data.stale) {
        setText(res.data.content);
        setModel(res.data.model ?? null);
        setCitedRules(res.data.citedRules ?? []);
        setPhase('ready');
        return;
      }
      void run(false);
    })();
    return () => {
      cancelled = true;
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, [book.id, run]);

  /* 生成期间每秒走一下秒表：等待必须有「还要多久」的交代（expectation-management） */
  useEffect(() => {
    if (phase !== 'generating') return undefined;
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  return (
    <div style={{ padding: `0 ${GUTTER}px ${BOTTOM_GAP}` }}>
      <NavBar
        backLabel={volume.name}
        onBack={onBack}
        accent={skin.fg}
        trailing={
          <span style={{ ...asStyle(AS_TYPE.heroSubtitle), color: read ? skin.fg : 'var(--text-muted)' }}>
            {read ? '已读' : ''}
          </span>
        }
      />

      <div style={{ marginTop: 12 }}>
        <Eyebrow color={skin.fg}>卷{volume.index} · {volume.name}</Eyebrow>
        <h1 style={{ margin: '8px 0 0', ...asStyle(AS_TYPE.sectionTitle), textWrap: 'pretty' }}>
          《{book.title}》
        </h1>
        <div style={{ marginTop: 6, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
          {book.author} · {TRACK_LABEL[book.track]} · {LEVEL_LABEL[book.level]}
        </div>
        <div style={{ marginTop: 10, ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.45, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
          <span style={{ fontWeight: 600, color: skin.fg }}>读完你能</span> {book.takeaway}
        </div>
      </div>

      {/* 精读稿 */}
      <div style={{ marginTop: 24 }}>
        {phase === 'loading' && (
          <p style={{ ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>正在看看有没有现成的稿子…</p>
        )}

        {phase === 'generating' && text.length === 0 && (
          /*
            还没有第一个字的时候也要有东西在动，而且要说清在等什么、等了多久。
            这一段之后会被流式正文顶掉。
          */
          <div style={{ padding: '14px 16px', borderRadius: AS_SPACE.shelfCardRadius, background: 'var(--shelf-inset)' }}>
            <div style={{ ...asStyle(AS_TYPE.itemTitle) }}>这本书还没有人读过，正在写精读稿</div>
            <div style={{ marginTop: 6, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)', lineHeight: 1.6 }}>
              第一个点进来的人要等一会儿，写完之后所有人读的都是这一篇。
              <br />
              已等待 {elapsed}s{model ? ` · ${model}` : ''}
            </div>
          </div>
        )}

        {text.length > 0 && (
          <StreamingText
            text={text}
            streaming={phase === 'generating'}
            markdown
            // 只传 markdown 不传 renderMarkdown 的话，StreamingText 里
            // `markdown && !!renderMarkdown` 判假，整篇退回纯文本渲染，
            // `## 这本书在说什么` 这些语法会原样裸露在屏幕上。
            renderMarkdown={(c) => <DigestMarkdown content={c} />}
          />
        )}

        {phase === 'failed' && (
          <div style={{ padding: '14px 16px', borderRadius: AS_SPACE.shelfCardRadius, background: 'var(--shelf-inset)' }}>
            <div style={{ ...asStyle(AS_TYPE.itemTitle) }}>稿子没写出来</div>
            <div style={{ marginTop: 6, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {error}
            </div>
            <div style={{ marginTop: 12, display: 'flex' }}>
              <Pill onClick={() => void run(true)} accent={skin.fg}>再试一次</Pill>
            </div>
          </div>
        )}
      </div>

      {/* 延伸阅读：这一稿引用了我们自己的哪几条规则 */}
      {phase === 'ready' && citedRules.length > 0 && (
        <div style={{ marginTop: AS_SPACE.sectionGap }}>
          <Eyebrow>这一篇对上的是我们自己的</Eyebrow>
          <GroupCard style={{ marginTop: AS_SPACE.titleGap }}>
            {citedRules.map((r) => (
              <div
                key={r}
                style={{
                  padding: `${AS_SPACE.listItemPaddingY}px ${AS_SPACE.listItemPaddingX}px`,
                  borderTop: '1px solid var(--border-faint)',
                  ...asStyle(AS_TYPE.itemSubtitle),
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  color: 'var(--text-secondary)',
                }}
              >
                .claude/rules/{r}.md
              </div>
            ))}
          </GroupCard>
        </div>
      )}

      {/* 读完之后才谈「写一句」—— 它是锦上添花，不该是这一屏唯一能做的事 */}
      <div style={{ marginTop: AS_SPACE.sectionGap }}>
        <Eyebrow>读完顺手记一句</Eyebrow>
        <textarea
          value={draft}
          maxLength={200}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft !== (bookNotes[book.id] ?? '')) setNote(book.id, draft); }}
          placeholder="打算在哪用它？一句话就够。"
          style={{
            marginTop: AS_SPACE.titleGap, width: '100%', minHeight: 64, boxSizing: 'border-box',
            borderRadius: AS_SPACE.iconRadius, background: 'var(--shelf-inset)',
            border: 0, outline: 'none', resize: 'none',
            padding: '12px 14px', ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.5,
            color: 'var(--text-primary)', fontFamily: 'inherit',
          }}
        />
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
        <Pill onClick={() => toggleRead(book.id)} tone={read ? 'soft' : 'solid'} accent={skin.fg} block height={44}>
          {read ? '取消已读' : '标记已读'}
        </Pill>
        {phase === 'ready' && (
          <Pill onClick={() => void run(true)} tone="soft" height={44}>重写一篇</Pill>
        )}
      </div>
    </div>
  );
}
