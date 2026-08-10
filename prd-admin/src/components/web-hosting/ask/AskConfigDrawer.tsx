import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, X } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { getSiteAskConfig, updateSiteAskConfig, type SiteAskConfig } from '@/services/real/webPages';

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
        setMaxLength(res.data.maxQuestionLength ?? 60);
      } else {
        setError(res.error?.message ?? '读取配置失败');
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [siteId]);

  const addQuestion = useCallback(() => {
    const q = draft.trim();
    if (!q) return;
    setQuestions((prev) => (prev.includes(q) ? prev : [...prev, q.slice(0, maxLength)]));
    setDraft('');
  }, [draft, maxLength]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const res = await updateSiteAskConfig(siteId, {
      enabled,
      welcome: welcome.trim() || null,
      suggestedQuestions: questions,
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
  }, [allowAnonymous, dailyLimit, enabled, onClose, onSaved, questions, siteId, welcome]);

  const body = (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80 }}>
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
              <Toggle checked={enabled} onChange={setEnabled} />
            </Row>

            <Row label="允许未登录访客提问" hint="关闭后，分享链接上的访客需要先登录才能提问。">
              <Toggle checked={allowAnonymous} onChange={setAllowAnonymous} />
            </Row>

            <div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>欢迎语</div>
              <textarea
                value={welcome}
                onChange={(e) => setWelcome(e.target.value)}
                rows={2}
                placeholder={`关于「${siteTitle}」，有什么想了解的？`}
                style={inputStyle}
              />
            </div>

            <div>
              <div style={{ fontSize: 13, marginBottom: 4 }}>开场问题题库</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
                访客打开面板时可以一点即问。分享的时候还能从这个题库里给每条链接单独挑几条——
                发给客户和发给同事，开场问题可以不一样。
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {questions.map((q, i) => (
                  <div key={q} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 9, background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}>
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{q}</span>
                    <button
                      onClick={() => setQuestions((prev) => prev.filter((_, idx) => idx !== i))}
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
                  placeholder="添加一个开场问题…"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  onClick={addQuestion}
                  disabled={!draft.trim()}
                  aria-label="添加"
                  style={{
                    width: 38, height: 38, borderRadius: 9, border: 'none', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: draft.trim() ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                    color: 'var(--text-primary)', cursor: draft.trim() ? 'pointer' : 'default',
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
              background: 'var(--accent-primary)', color: 'var(--text-primary)',
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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative', width: 38, height: 21, borderRadius: 999, border: 'none', cursor: 'pointer',
        background: checked ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
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
