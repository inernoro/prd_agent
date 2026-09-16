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
  /*
   * 平台后端三个出口（GET / cached / start）一直都在发，前端从来没接——
   * 建了一半的链路，不报错也不变红（形状 2）。`ai-model-visibility` 要的是
   * 「{模型} · {平台}」，缺一半就不算兑现。
   */
  const [platform, setPlatform] = useState<string | null>(null);
  const [citedRules, setCitedRules] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState(bookNotes[book.id] ?? '');
  // 用户有没有真的动过这个输入框。区分「还没写」与「写了又清空」——
  // 后者是一次真实的删除意图，不该被服务端那份盖回去。
  const draftTouchedRef = useRef(false);

  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  const serverNote = bookNotes[book.id] ?? '';

  /*
   * 服务端那份笔记是在这一屏挂载**之后**才到的（深链直接进书页、或刚登录就进来时，
   * loadFromServer 还在路上），useState 的初值只取了当时的空值，之后不会自己跟上。
   *
   * 不跟上的后果不是「少显示一条」，是**删数据**：输入框显示空的，用户一个字没打，
   * 只要聚焦再失焦，onBlur 那句 `draft !== 服务端那份` 就成立，于是把已有的笔记
   * 用空串覆盖掉并同步出去。用户没做任何事，笔记没了。
   *
   * 所以只在「用户还没动过这个框」时跟随服务端；动过之后他手上那份优先。
   */
  useEffect(() => {
    if (draftTouchedRef.current) return;
    setDraft(serverNote);
  }, [serverNote]);

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
          setPlatform(evt.platform ?? null);
          setCitedRules(evt.citedRules ?? []);
          setPhase('ready');
        } else if (evt.type === 'start') {
          setModel(evt.model ?? null);
          setPlatform(evt.platform ?? null);
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
        setPlatform(res.data.platform ?? null);
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

  /*
   * 取稿与生成期间都要走秒表：等待必须有「还要多久」的交代（expectation-management）。
   * 只覆盖 generating 是不够的——取稿那一下走的是网络，慢起来一样会超过两秒，
   * 而那时屏幕上只有一句不动的话（AGENTS.md §6：静止的「加载中」超过 2 秒即缺陷）。
   */
  useEffect(() => {
    if (phase !== 'loading' && phase !== 'generating') return undefined;
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
          /* 骨架用的是产物自己的形状（三段标题 + 段落），不是通用 spinner：
             用户在等一篇文章，屏幕上动的就该是一篇文章的轮廓（artifact-is-experience）。 */
          <div>
            <p style={{ ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
              正在看看有没有现成的稿子{elapsed > 0 ? ` · 已等待 ${elapsed}s` : '…'}
            </p>
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[72, 100, 100, 88, 56, 100, 94].map((w, i) => (
                <div
                  key={i}
                  style={{
                    height: i === 0 || i === 4 ? 15 : 11,
                    width: `${w}%`,
                    borderRadius: 4,
                    background: 'var(--shelf-inset)',
                    animation: 'bookshelfDigestSkeleton 1.4s ease-in-out infinite',
                    animationDelay: `${i * 0.12}s`,
                  }}
                />
              ))}
            </div>
            <style>{`@keyframes bookshelfDigestSkeleton{0%,100%{opacity:.45}50%{opacity:.9}}`}</style>
          </div>
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

        {/*
          * 署名常驻，不是只在第一个字到达之前露一下。
          * 读者手上这篇是模型写的，他有权在读的全程知道是哪个模型、哪个平台写的——
          * 尤其库里那篇（cached）以前一次都没显示过（`ai-model-visibility`）。
          */}
        {text.length > 0 && model && (
          <div
            style={{
              marginBottom: 12,
              ...asStyle(AS_TYPE.eyebrow),
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            }}
          >
            {model}{platform ? ` · ${platform}` : ''}
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
              {/*
                * force=false：失败多半只是这条 SSE 连接断了，而后端是拿
                * CancellationToken.None 在跑的——那一篇很可能已经写完并落库了。
                * 传 true 等于「无论如何再烧一篇」，既多花一次钱，又会把刚落库的
                * 那篇公共稿子覆盖掉。想重写有下面那个「重写一篇」。
                */}
              <Pill onClick={() => void run(false)} accent={skin.fg}>再试一次</Pill>
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
          onChange={(e) => { draftTouchedRef.current = true; setDraft(e.target.value); }}
          onBlur={() => { if (draft !== serverNote) setNote(book.id, draft); }}
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
