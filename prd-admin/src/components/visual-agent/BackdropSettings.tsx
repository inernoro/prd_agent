import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ImageOff, Images, Sparkles, Trash2, Settings2, X } from 'lucide-react';
import {
  ROTATION_DAYS,
  daysUntilRotation,
  nextRotationAt,
  pickBackdrop,
  type BackdropAsset,
} from '@/lib/backdropRotation';
import {
  BACKDROP_MOOD_SUGGESTIONS,
  generateBackdrop,
  pushGeneratedBackdrop,
  removeGeneratedBackdrop,
  type BackdropGenProgress,
} from '@/lib/backdropStudio';
import { MapSpinner } from '@/components/ui/VideoLoader';

/**
 * 首页背景的轮换与设置。
 *
 * 素材从哪来：随包四张**专门为「当背景」而画**的暗调图（见 backdropCatalog.ts），
 * 加上用户自己在这里生成的。第一版用的是「你自己项目的封面图」，取证后推翻了——
 * 真实封面绝大多数是白底产品图，压到暗罩底下把整页变成一片平灰，那张图自己也看不出来。
 *
 * 偏好存 localStorage：纯 UI 偏好、设备本地、发版后用旧值无害，
 * 符合 no-localstorage 规则的例外清单（服务器权威数据仍然禁止进这里）。
 */

const PREF_KEY = 'visualAgent.backdrop.mode';

/** 'auto' 跟随轮换；'off' 关掉背景；其余值是被钉住的那张素材 id。 */
export type BackdropMode = 'auto' | 'off' | (string & {});

export function readBackdropMode(): BackdropMode {
  try {
    return (localStorage.getItem(PREF_KEY) as BackdropMode) || 'auto';
  } catch {
    // 隐私模式 / 禁用站点数据时读取会抛，此时按默认走，不能让首页崩。
    return 'auto';
  }
}

function writeBackdropMode(mode: BackdropMode) {
  try {
    localStorage.setItem(PREF_KEY, mode);
  } catch {
    /* 存不下就只在本次会话生效，不打断用户 */
  }
}

/** 按偏好解析出「现在该显示哪张」。mode 是钉住的 id 但素材已不在池里时，退回轮换。 */
export function resolveBackdrop(
  assets: readonly BackdropAsset[],
  mode: BackdropMode,
  at: number | Date = Date.now(),
): BackdropAsset | null {
  if (mode === 'off') return null;
  if (mode !== 'auto') {
    const pinned = assets.find((a) => a.id === mode);
    if (pinned) return pinned;
  }
  return pickBackdrop(assets, at);
}

/** 生成中的一句话状态。等待期屏幕上必须有持续变化的东西——这里是阶段 + 秒数。 */
function genPhaseText(p: BackdropGenProgress): string {
  const s = Math.round(p.elapsedMs / 1000);
  const stage = p.phase === 'resolving' ? '正在挑选生图模型'
    : p.phase === 'queued' ? '任务已排队'
    : p.phase === 'running' ? '模型正在画'
    : '正在收图';
  // 实测一张 1536x1024 约 45 秒，把这个预期直接说出来，别让人猜。
  return `${stage}…已等待 ${s}s，通常 40-60s`;
}

export function BackdropSettings(props: {
  assets: readonly BackdropAsset[];
  generated: readonly BackdropAsset[];
  onGeneratedChange: (next: BackdropAsset[]) => void;
  mode: BackdropMode;
  onModeChange: (mode: BackdropMode) => void;
}) {
  const { assets, generated, onGeneratedChange, mode, onModeChange } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 生成态。氛围输入框预填一句建议——零摩擦：用户改的是差异，不是从空白开始想。
  const [mood, setMood] = useState(() => BACKDROP_MOOD_SUGGESTIONS[Math.floor(Math.random() * BACKDROP_MOOD_SUGGESTIONS.length)]!);
  const [progress, setProgress] = useState<BackdropGenProgress | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 关闭面板不取消生成（server-authority：任务在服务端，关个面板不该把它杀掉），
  // 但组件真正卸载时要断开轮询，免得 setState 打到已卸载的组件上。
  useEffect(() => () => abortRef.current?.abort(), []);

  const current = useMemo(() => resolveBackdrop(assets, mode), [assets, mode]);
  const rotating = mode === 'auto';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const pick = (next: BackdropMode) => {
    onModeChange(next);
    writeBackdropMode(next);
  };

  const runGenerate = async () => {
    if (progress) return;
    setGenError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ phase: 'resolving', elapsedMs: 0 });
    try {
      const asset = await generateBackdrop({ mood, signal: ctrl.signal, onProgress: setProgress });
      onGeneratedChange(pushGeneratedBackdrop(asset));
      pick(asset.id); // 出图即钉住：用户点「生成」就是想看这一张，不该还要再点一下
    } catch (e) {
      setGenError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const dropGenerated = (id: string) => {
    const next = removeGeneratedBackdrop(id);
    onGeneratedChange(next);
    if (mode === id) pick('auto'); // 删掉的正是钉住的那张，退回轮换，别留一个指向空气的偏好
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="backdrop-settings-trigger"
        aria-label="背景设置"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 hover-bg-soft"
        style={{
          minHeight: 36,
          padding: '0 10px',
          borderRadius: 7,
          border: 0,
          background: 'transparent',
          color: 'var(--text-secondary)',
          fontSize: 11,
          cursor: 'pointer',
        }}
        title="背景设置"
      >
        <Settings2 size={14} />
        背景
      </button>

      {open && (
        <div
          data-testid="backdrop-settings-panel"
          className="absolute right-0 z-50 mt-1.5"
          style={{
            top: '100%',
            width: 320,
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background: 'var(--panel-solid)',
            boxShadow: 'var(--shadow-glass-dropdown)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: '11px 12px', borderBottom: '1px solid var(--border-faint)' }}
          >
            <strong style={{ color: 'var(--text-primary)', fontSize: 12 }}>背景</strong>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => setOpen(false)}
              className="grid place-items-center hover-bg-soft"
              style={{ width: 22, height: 22, borderRadius: 4, border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              <X size={12} />
            </button>
          </div>

          <div style={{ padding: '10px 12px' }}>
            {/* 说清「现在是哪张、下一张什么时候来」。没有这两行，自动轮换对用户就是「它自己变了」。 */}
            <div style={{ color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.7 }}>
              {assets.length === 0 ? (
                <span data-testid="backdrop-empty">还没有可用素材。</span>
              ) : mode === 'off' ? (
                <span>背景已关闭，页面只保留潜像场。</span>
              ) : rotating ? (
                <span data-testid="backdrop-rotation-hint">
                  每 {ROTATION_DAYS} 天自动换一张。
                  <br />
                  当前「{current?.name || '未命名'}」·{' '}
                  {daysUntilRotation()} 天后换下一张（{nextRotationAt().toLocaleDateString()}）
                </span>
              ) : (
                <span>已钉住「{current?.name || '未命名'}」，不再自动更换。</span>
              )}
            </div>

            <div className="mt-2.5 flex items-center gap-1.5">
              <ModeChip active={rotating} disabled={assets.length === 0} onClick={() => pick('auto')} icon={<Images size={12} />} label="自动轮换" />
              <ModeChip active={mode === 'off'} onClick={() => pick('off')} icon={<ImageOff size={12} />} label="不用背景" />
            </div>

            {assets.length > 0 && (
              <>
                <div className="mt-3 mb-1.5" style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                  或钉住一张
                </div>
                {/* 3:2 而不是方形：这几张是横构图的光影，方形裁切会把光的来向裁掉。 */}
                <div className="grid grid-cols-3 gap-1.5 overflow-y-auto" style={{ maxHeight: 190 }}>
                  {assets.map((a) => {
                    const pinned = mode === a.id;
                    const isGenerated = generated.some((g) => g.id === a.id);
                    return (
                      <div key={a.id} className="relative">
                        <button
                          type="button"
                          onClick={() => pick(a.id)}
                          title={a.note ? `${a.name} · ${a.note}` : a.name}
                          className="relative block w-full overflow-hidden"
                          style={{
                            aspectRatio: '3 / 2',
                            borderRadius: 6,
                            border: 0,
                            padding: 0,
                            cursor: 'pointer',
                            background: 'var(--bg-secondary)',
                            boxShadow: pinned ? 'inset 0 0 0 2px var(--accent-primary)' : undefined,
                          }}
                        >
                          <img src={a.url} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          {pinned && (
                            <span
                              className="absolute grid place-items-center"
                              style={{ right: 3, bottom: 3, width: 15, height: 15, borderRadius: 999, background: 'var(--accent-primary-solid)', color: 'var(--accent-on-solid)' }}
                            >
                              <Check size={9} />
                            </span>
                          )}
                        </button>
                        {isGenerated && (
                          <button
                            type="button"
                            aria-label={`删除 ${a.name}`}
                            onClick={() => dropGenerated(a.id)}
                            className="absolute grid place-items-center"
                            style={{
                              left: 3, top: 3, width: 16, height: 16, borderRadius: 4, border: 0,
                              background: 'var(--panel-solid)', color: 'var(--text-muted)', cursor: 'pointer',
                            }}
                          >
                            <Trash2 size={9} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* 生成自己的背景。走的是本产品自己的生图链路，不另开通道。 */}
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-faint)' }}>
              <div className="mb-1.5" style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                想要别的？描述一句氛围，让它画一张
              </div>
              <textarea
                value={mood}
                onChange={(e) => setMood(e.target.value)}
                rows={2}
                disabled={!!progress}
                data-testid="backdrop-mood-input"
                className="w-full resize-none"
                style={{
                  padding: '7px 9px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: 10,
                  lineHeight: 1.6,
                  outline: 'none',
                }}
              />
              {/* 「近黑、无主体、大量负空间」是不给改的硬约束——改掉它出来的就不是背景图了。 */}
              <div className="mt-1" style={{ color: 'var(--text-muted)', fontSize: 9, lineHeight: 1.6 }}>
                近黑底色、没有主体物、大量负空间这几条是固定的，只有氛围这句跟着你写。
              </div>

              {progress ? (
                <div
                  data-testid="backdrop-gen-progress"
                  className="mt-2 flex items-center gap-2"
                  style={{ color: 'var(--text-secondary)', fontSize: 10 }}
                >
                  <MapSpinner size={14} />
                  {genPhaseText(progress)}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={runGenerate}
                  data-testid="backdrop-generate"
                  className="mt-2 inline-flex items-center gap-1.5"
                  style={{
                    minHeight: 30,
                    padding: '0 11px',
                    borderRadius: 6,
                    border: 0,
                    cursor: 'pointer',
                    background: 'var(--text-primary)',
                    color: 'var(--bg-base)',
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                >
                  <Sparkles size={11} />
                  生成一张
                </button>
              )}
              {genError && (
                <div data-testid="backdrop-gen-error" className="mt-2" style={{ color: 'var(--semantic-danger-text)', fontSize: 10, lineHeight: 1.6 }}>
                  {genError}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModeChip(props: { active: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  const { active, disabled, onClick, icon, label } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 hover-bg-soft disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        minHeight: 30,
        padding: '0 9px',
        borderRadius: 6,
        border: 0,
        fontSize: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: active ? 'var(--bg-card)' : 'var(--bg-secondary)',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        boxShadow: active ? 'inset 0 0 0 1px var(--accent-primary), var(--shadow-card-sm)' : undefined,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
