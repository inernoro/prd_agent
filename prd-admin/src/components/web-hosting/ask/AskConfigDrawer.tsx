import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, RotateCw, Trash2, X } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { getSiteAskConfig, regenerateSiteAskQuestions, updateSiteAskConfig, type SiteAskConfig } from '@/services/real/webPages';
import { ASK_MAX_WELCOME_LENGTH } from './askTypes';

interface Props {
  siteId: string;
  siteTitle: string;
  onClose: () => void;
  onSaved?: (config: SiteAskConfig) => void;
}

/**
 * 站点「向我提问」配置抽屉（owner / editor）。
 *
 * 这里维护的是**站点级题库**——分享的时候可以从这个池子里给每条链接各挑几条
 * （见分享面板的开场问题选择器）。所以这里允许存的条数比面板实际展示的多。
 */
export default function AskConfigDrawer({ siteId, siteTitle, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [welcome, setWelcome] = useState('');
  const [allowAnonymous, setAllowAnonymous] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(0);
  const [questions, setQuestions] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [maxLength, setMaxLength] = useState(60);
  /** 题库条数上限（后端下发）。到顶必须挡住，不然第 N+1 条存进去又静默消失 */
  const [maxQuestions, setMaxQuestions] = useState(12);
  /** 站点形态不支持提问时的原因；非空则开关灰掉（服务端同一判定源，前端不自己判） */
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  /** 这批题是系统读正文写的（auto）还是 owner 自己写的（manual） */
  const [questionsSource, setQuestionsSource] = useState<'auto' | 'manual'>('auto');
  /**
   * 这次开着抽屉的期间，用户有没有真的动过题库。
   *
   * 保存时只有它为 true 才把题库送上去。抽屉里那份题是**打开那一刻**读到的旧值，而打开
   * 这一下会顺手排一次后台生成；只改了别的开关就保存却把旧值一起送上去，会盖掉这期间
   * 生成好的题，还会被后端判成「owner 手写过」从此钉成 manual，自动生成再也补不回来。
   * 「重新生成」写回的那份也不算动手——那是系统写的，不该把站点钉成 manual。
   */
  const [questionsDirty, setQuestionsDirty] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  /** 重新生成没生成出东西时，后端的原话。不自己编一句「失败了」 */
  const [regenNote, setRegenNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getSiteAskConfig(siteId).then((res) => {
      if (!alive) return;
      if (res.success && res.data) {
        setEnabled(res.data.enabled);
        setWelcome(res.data.welcome ?? '');
        setAllowAnonymous(res.data.allowAnonymous);
        setDailyLimit(res.data.dailyLimit ?? 0);
        setQuestions(res.data.suggestedQuestions ?? []);
        setQuestionsSource(res.data.questionsSource === 'manual' ? 'manual' : 'auto');
        setMaxLength(res.data.maxQuestionLength ?? 60);
        setMaxQuestions(res.data.maxQuestions ?? 12);
        setUnsupportedReason(res.data.supported === false ? (res.data.unsupportedReason ?? '这个站点暂不支持提问。') : null);
      } else {
        setError(res.error?.message ?? '读取配置失败');
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [siteId]);

  const atLibraryCap = questions.length >= maxQuestions;

  const addQuestion = useCallback(() => {
    const q = draft.trim();
    if (!q) return;
    setQuestions((prev) =>
      prev.includes(q) || prev.length >= maxQuestions ? prev : [...prev, q.slice(0, maxLength)],
    );
    // 界面上立刻改口径：他一动手，这批题就归他了，之后重新上传不会再被自动覆盖。
    // 与后端判据同义（后端按提交的列表与库里那份是否相同来判），这里只是提前说出来。
    setQuestionsSource('manual');
    setQuestionsDirty(true);
    setRegenNote(null);
    setDraft('');
  }, [draft, maxLength, maxQuestions]);

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    setRegenNote(null);
    const res = await regenerateSiteAskQuestions(siteId);
    setRegenerating(false);
    if (!res.success) {
      setRegenNote(res.error?.message ?? '重新生成失败');
      return;
    }
    setQuestions(res.data?.suggestedQuestions ?? []);
    setQuestionsSource('auto');
    // 这份是系统刚写进库的，不是他动的手：保存时不要再送回去把站点钉成 manual。
    setQuestionsDirty(false);
    // 没生成出来就把后端的原话摆出来（这一页读不出正文 / 模型没给出可用问题），
    // 不假装成功，也不自己换一套说法（no-rootless-tree）
    if (!res.data?.generated) setRegenNote(res.data?.message ?? '这一页没能读出可提问的正文。');
  }, [siteId]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const res = await updateSiteAskConfig(siteId, {
      enabled,
      welcome: welcome.trim() || null,
      ...(questionsDirty ? { suggestedQuestions: questions } : {}),
      allowAnonymous,
      dailyLimit,
    });
    setSaving(false);
    if (!res.success) {
      setError(res.error?.message ?? '保存失败');
      return;
    }
    onSaved?.(res.data);
    onClose();
  }, [allowAnonymous, dailyLimit, enabled, onClose, onSaved, questions, questionsDirty, siteId, welcome]);

  const body = (
    // z-index 必须高于 SitePreviewModal 的 z-[100]：本抽屉唯一的入口就在那个弹窗的顶栏里，
    // 两者又是并列的 portal（都挂 body）。80 < 100 意味着抽屉永远被弹窗盖住点不到，
    // 而提问默认关闭、这里是唯一的开启入口——等于整个功能没人打得开。
    <div style={{ position: 'fixed', inset: 0, zIndex: 110 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--overlay-scrim, rgba(0,0,0,0.45))' }} />
      <aside
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(440px, 94vw)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--panel-solid, var(--bg-elevated))',
          borderLeft: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-glass-drawer)',
          color: 'var(--text-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border-faint)', flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>提问设置</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{siteTitle}</div>
          </div>
          <button onClick={onClose} aria-label="关闭" style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <MapSectionLoader text="正在读取配置…" />
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Row
              label="开放提问"
              hint="访客可以对着这个页面向 AI 提问，回答只依据页面内容。每次提问都会消耗模型额度，所以默认关闭。"
            >
              {/* 只挡「关 → 开」，永远保留「开 → 关」这条退路。
                  两个方向一起挡会造成一种没法自救的状态：HTML 站重传成视频之后形态变成不支持，
                  但 AskEnabled 还是 true，开关又被灰掉——owner 想关都关不掉，
                  而已发出去的分享还挂着一个每次必 422 的提问入口。
                  后端 PUT 也只拒绝「开」，两边判据一致。 */}
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                disabled={!!unsupportedReason && !enabled}
              />
            </Row>

            {/* 不支持的形态（如视频包装站）如实说明，而不是让 owner 打开一个
                每个访客都会失败的开关。判定源在服务端，前端不自己判。 */}
            {unsupportedReason && (
              <div style={{
                marginTop: -8, padding: '8px 10px', borderRadius: 8,
                background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6,
              }}>
                {unsupportedReason}
                {enabled && '（这个站点当前仍开着提问，访客每次提问都会失败，建议关掉。）'}
              </div>
            )}

            <Row label="允许未登录访客提问" hint="关闭后，分享链接上的访客需要先登录才能提问。">
              <Toggle checked={allowAnonymous} onChange={setAllowAnonymous} />
            </Row>

            <div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>欢迎语</div>
              <textarea
                value={welcome}
                onChange={(e) => setWelcome(e.target.value)}
                rows={2}
                // 与后端同一个上限。后端超长是截断（展示文案，截短不改变行为），
                // 这里把边界前移到打字时，用户不会写完一大段才发现被砍
                maxLength={ASK_MAX_WELCOME_LENGTH}
                placeholder={`关于「${siteTitle}」，有什么想了解的？`}
                style={inputStyle}
              />
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ fontSize: 13 }}>开场问题题库</div>
                {/* 来源标签：自动填的东西不能是黑箱，用户得看得出这几句是谁写的 */}
                <span
                  style={{
                    fontSize: 10.5, padding: '2px 7px', borderRadius: 5, flexShrink: 0,
                    fontFamily: 'var(--font-code, ui-monospace, monospace)',
                    background: questionsSource === 'manual' ? 'var(--bg-tertiary)' : 'var(--semantic-info-soft)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {questionsSource === 'manual' ? '你自己写的' : '系统读正文生成'}
                </span>
                <button
                  onClick={() => void regenerate()}
                  disabled={regenerating || !!unsupportedReason}
                  title="重新读一遍这一页的正文，写一批新的开场问题；会覆盖现在这几条"
                  style={{
                    marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
                    height: 26, padding: '0 9px', borderRadius: 7,
                    border: '1px solid var(--border-subtle)', background: 'transparent',
                    color: 'var(--text-muted)', fontSize: 11.5,
                    cursor: regenerating || unsupportedReason ? 'default' : 'pointer',
                  }}
                >
                  {regenerating ? <MapSpinner size={12} /> : <RotateCw size={12} />}
                  {regenerating ? '正在读正文…' : '重新生成'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
                访客打开面板时可以一点即问。分享的时候还能从这个题库里给每条链接单独挑几条——
                发给客户和发给同事，开场问题可以不一样。
                {questionsSource === 'auto' && '这几条是开启提问时系统读你上传的正文写的，你改过之后就不再被自动覆盖。'}
              </div>
              {regenNote && (
                <div style={{ fontSize: 12, color: 'var(--accent-primary)', marginBottom: 8, lineHeight: 1.6 }}>
                  {regenNote}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {questions.map((q, i) => (
                  <div key={q} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 9, background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}>
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{q}</span>
                    <button
                      onClick={() => {
                        setQuestions((prev) => prev.filter((_, idx) => idx !== i));
                        setQuestionsSource('manual');
                        setQuestionsDirty(true);
                        setRegenNote(null);
                      }}
                      aria-label={`删除「${q}」`}
                      style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', flexShrink: 0 }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  value={draft}
                  maxLength={maxLength}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addQuestion();
                    }
                  }}
                  placeholder={atLibraryCap ? `最多 ${maxQuestions} 条，删掉一条再加` : '添加一个开场问题…'}
                  disabled={atLibraryCap}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  onClick={addQuestion}
                  disabled={!draft.trim() || atLibraryCap}
                  aria-label="添加"
                  style={{
                    width: 38, height: 38, borderRadius: 9, border: 'none', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: draft.trim() && !atLibraryCap ? 'var(--button-primary-bg)' : 'var(--bg-tertiary)',
                    color: draft.trim() && !atLibraryCap ? 'var(--button-primary-fg)' : 'var(--text-muted)',
                    cursor: draft.trim() && !atLibraryCap ? 'pointer' : 'default',
                  }}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            <div>
              <div style={{ fontSize: 13, marginBottom: 4 }}>每日提问上限</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                0 = 用系统默认值。到达上限后当天不再接受提问，防止公开页面被刷爆额度。
              </div>
              <input
                type="number"
                min={0}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Math.max(0, Number(e.target.value) || 0))}
                style={{ ...inputStyle, width: 140 }}
              />
            </div>

            {error && <div style={{ fontSize: 12, color: 'var(--accent-primary)' }}>{error}</div>}
          </div>
        )}

        <div style={{ padding: 14, borderTop: '1px solid var(--border-faint)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer' }}>
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || loading}
            style={{
              padding: '8px 16px', borderRadius: 9, border: 'none', fontSize: 13,
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)',
              cursor: saving || loading ? 'default' : 'pointer',
            }}
          >
            {saving && <MapSpinner size={13} />}
            保存
          </button>
        </div>
      </aside>
    </div>
  );

  return createPortal(body, document.body);
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 9,
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
  resize: 'vertical',
};

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.6 }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0, paddingTop: 2 }}>{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        position: 'relative', width: 38, height: 21, borderRadius: 999, border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        background: checked ? 'var(--button-primary-bg)' : 'var(--bg-tertiary)',
        transition: 'background 0.18s',
      }}
    >
      <span
        style={{
          position: 'absolute', top: 2.5, left: checked ? 19 : 2.5,
          width: 16, height: 16, borderRadius: '50%',
          background: 'var(--text-primary)', transition: 'left 0.18s',
        }}
      />
    </button>
  );
}
