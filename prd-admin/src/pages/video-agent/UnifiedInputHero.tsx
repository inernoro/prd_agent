/**
 * 统一输入 Hero：视频 Agent 入口主视觉
 *
 * 设计目标：心智降到只剩一件事——描述或上传。
 * - 拖拽 / 点击上传 文档（PDF / Word / Markdown）
 * - 或粘贴 / 输入 文本描述
 * - 底部示例 chip 一键填入
 * - 所有参数（标题 / 系统提示词 / 风格 / 模型档 / 时长 / 宽高）默认折叠在「高级设置 ▸」
 *
 * 不做路由判定——路由由父组件 detectVideoMode 完成，Hero 只负责采集输入。
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  Upload,
  Paperclip,
  X,
  ChevronDown,
  ChevronUp,
  Sparkles,
  FileType2,
  Wand2,
  Zap,
  Scale,
  Crown,
  Clock,
  Maximize2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  OPENROUTER_VIDEO_MODELS,
  VIDEO_MODEL_TIERS,
} from '@/services/contracts/videoAgent';
import type { RoutePreference, VideoMode } from './videoModeDetect';
import { detectVideoMode } from './videoModeDetect';

const TIER_ICONS = { economy: Zap, balanced: Scale, premium: Crown } as const;

export interface UnifiedInputState {
  text: string;
  attachments: Array<{ attachmentId: string; fileName: string }>;
  // 高级设置
  routePreference: RoutePreference;
  title: string;
  systemPrompt: string;
  styleDescription: string;
  model: string; // '' = auto
  duration: number;
  aspect: '16:9' | '9:16' | '1:1';
  resolution: '480p' | '720p' | '1080p';
}

export interface UnifiedInputHeroProps {
  value: UnifiedInputState;
  onChange: (patch: Partial<UnifiedInputState>) => void;
  onSubmit: () => void;
  onFileSelect: (files: File[]) => Promise<void>;
  onRemoveAttachment: (attachmentId: string) => void;
  uploading: boolean;
  submitting: boolean;
}

const EXAMPLES: Array<{ label: string; text: string; hintMode: VideoMode }> = [
  {
    label: '一只金毛在海滩奔跑',
    text: '一只金毛犬在落日的海滩上奔跑追逐海浪，电影级光影，慢动作镜头',
    hintMode: 'videogen',
  },
  {
    label: '咖啡馆拉花特写',
    text: '咖啡馆吧台，咖啡师正在拉花，奶泡形成精美的天鹅图案，柔和自然光',
    hintMode: 'videogen',
  },
  {
    label: '粘贴一段产品介绍',
    text: '',
    hintMode: 'remotion',
  },
];

export const UnifiedInputHero: React.FC<UnifiedInputHeroProps> = ({
  value,
  onChange,
  onSubmit,
  onFileSelect,
  onRemoveAttachment,
  uploading,
  submitting,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const decision = detectVideoMode({
    text: value.text,
    attachmentsCount: value.attachments.length,
    preference: value.routePreference,
  });

  const canSubmit =
    !submitting &&
    !uploading &&
    (value.text.trim().length > 0 || value.attachments.length > 0);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) {
        void onFileSelect(files);
      }
    },
    [onFileSelect],
  );

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) void onFileSelect(files);
  };

  return (
    <div className="w-full max-w-[880px] mx-auto flex flex-col gap-4 px-4 py-8">
      {/* 标题 */}
      <div className="text-center flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-wide" style={{ color: 'var(--text-primary)' }}>
          想做什么视频？
        </h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          描述画面出短片，或上传文档拆分镜
        </p>
      </div>

      {/* 主输入区 */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={cn('relative rounded-[20px] p-4 flex flex-col gap-3 transition-colors')}
        style={{
          background: 'var(--panel)',
          border: '1px solid ' + (dragActive ? 'rgba(236,72,153,0.6)' : 'var(--border-default)'),
          boxShadow: dragActive
            ? '0 0 0 3px rgba(236,72,153,0.15)'
            : 'var(--shadow-card)',
        }}
      >
        <textarea
          value={value.text}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="例：一只金毛在落日海滩上奔跑… 或 粘贴一段产品介绍文案、PRD 大纲…"
          rows={4}
          disabled={submitting}
          className="w-full resize-none bg-transparent text-sm outline-none"
          style={{ color: 'var(--text-primary)', minHeight: 88 }}
        />

        {/* 附件 chip 列表 */}
        {value.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {value.attachments.map((att) => (
              <span
                key={att.attachmentId}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px]"
                style={{
                  background: 'rgba(236,72,153,0.08)',
                  border: '1px solid rgba(236,72,153,0.25)',
                  color: 'var(--text-primary)',
                }}
              >
                <Paperclip size={10} />
                <span className="max-w-[220px] truncate">{att.fileName}</span>
                <button
                  onClick={() => onRemoveAttachment(att.attachmentId)}
                  className="ml-0.5 opacity-60 hover:opacity-100"
                  title="移除"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 底部工具栏 */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || submitting}
            title="PDF / Word / Markdown / TXT，多文件"
          >
            {uploading ? <MapSpinner size={12} /> : <Upload size={14} />}
            上传文件
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.md,.markdown,.txt,.html,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
            className="hidden"
            onChange={handleFilePick}
          />

          {/* 自动路由提示（实时显示当前判定） */}
          <div
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md"
            style={{
              color: decision.mode === 'remotion' ? '#f472b6' : '#a78bfa',
              background: decision.mode === 'remotion' ? 'rgba(236,72,153,0.08)' : 'rgba(167,139,250,0.08)',
              border: '1px solid ' + (decision.mode === 'remotion' ? 'rgba(236,72,153,0.2)' : 'rgba(167,139,250,0.2)'),
            }}
            title={decision.reason}
          >
            {decision.mode === 'remotion' ? (
              <>
                <FileType2 size={11} /> 即将：拆分镜
              </>
            ) : (
              <>
                <Wand2 size={11} /> 即将：一镜直出
              </>
            )}
          </div>

          <div className="flex-1" />

          <Button
            variant="primary"
            size="sm"
            onClick={onSubmit}
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <MapSpinner size={12} /> 提交中…
              </>
            ) : (
              <>
                <Sparkles size={12} /> 立即生成
              </>
            )}
          </Button>
        </div>
      </div>

      {/* 生成方式选择（常驻可见，不再藏在高级设置里） */}
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          生成方式
        </span>
        <div
          className="inline-flex rounded-lg overflow-hidden"
          style={{ border: '1px solid var(--border-default)' }}
        >
          {([
            { key: 'auto' as const, label: '🤖 自动判定', tooltip: '系统按输入长度/附件自动选 Remotion 或直出' },
            { key: 'remotion' as const, label: '🎬 拆分镜（Remotion）', tooltip: '生成多镜头，逐镜可编辑、混合渲染' },
            { key: 'videogen' as const, label: '✨ 直通大模型', tooltip: '一段提示词 → 大模型一镜直出整段视频' },
          ]).map((opt) => {
            const active = value.routePreference === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => onChange({ routePreference: opt.key })}
                className="px-3 py-1.5 text-[11px] transition-colors"
                style={{
                  background: active ? 'rgba(236,72,153,0.16)' : 'transparent',
                  color: active ? '#f472b6' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 400,
                }}
                title={opt.tooltip}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 示例 chip */}
      <div className="flex items-center gap-1.5 flex-wrap justify-center">
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          示例：
        </span>
        {EXAMPLES.filter((ex) => ex.text).map((ex) => (
          <button
            key={ex.label}
            onClick={() => onChange({ text: ex.text })}
            className="text-[11px] px-2 py-1 rounded-md hover:opacity-80 transition-opacity"
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-secondary)',
            }}
          >
            {ex.label}
          </button>
        ))}
      </div>

      {/* 高级设置折叠 */}
      <div className="flex flex-col gap-2">
        <button
          onClick={() => setShowAdvanced((s) => !s)}
          className="self-center inline-flex items-center gap-1 text-[11px]"
          style={{ color: 'var(--text-muted)' }}
        >
          高级设置
          {showAdvanced ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>

        {showAdvanced && (
          <div
            className="rounded-[14px] p-4 flex flex-col gap-3"
            style={{
              background: 'var(--bg-base)',
              border: '1px dashed var(--border-default)',
            }}
          >
            {/* 视频标题 */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                视频标题（可选，留空自动提取）
              </label>
              <input
                value={value.title}
                onChange={(e) => onChange({ title: e.target.value })}
                className="w-full rounded-md px-2 py-1.5 text-xs outline-none"
                style={{
                  background: 'var(--panel)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            {/* 直出模式专属参数 */}
            {(value.routePreference === 'auto' || value.routePreference === 'videogen') && (
              <div
                className="flex flex-col gap-2 rounded-lg p-3"
                style={{ background: 'var(--panel)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="text-[11px] font-medium inline-flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                  <Wand2 size={11} /> 一镜直出参数（短描述时生效）
                </div>

                {/* 模型档 */}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => onChange({ model: '' })}
                    className="text-[10px] px-2 py-1 rounded-md"
                    style={{
                      background: value.model === '' ? 'rgba(236,72,153,0.14)' : 'var(--bg-base)',
                      border: '1px solid ' + (value.model === '' ? 'rgba(236,72,153,0.4)' : 'var(--border-default)'),
                      color: value.model === '' ? '#f472b6' : 'var(--text-primary)',
                    }}
                  >
                    <Sparkles size={9} className="inline" /> 自动
                  </button>
                  {VIDEO_MODEL_TIERS.map((t) => {
                    const Icon = TIER_ICONS[t.tier];
                    const active = value.model === t.modelId;
                    return (
                      <button
                        key={t.tier}
                        onClick={() => onChange({ model: t.modelId })}
                        className="text-[10px] px-2 py-1 rounded-md"
                        style={{
                          background: active ? 'rgba(236,72,153,0.14)' : 'var(--bg-base)',
                          border: '1px solid ' + (active ? 'rgba(236,72,153,0.4)' : 'var(--border-default)'),
                          color: active ? '#f472b6' : 'var(--text-primary)',
                        }}
                        title={t.desc}
                      >
                        <Icon size={9} className="inline" /> {t.label}
                      </button>
                    );
                  })}
                  <select
                    value={value.model}
                    onChange={(e) => onChange({ model: e.target.value })}
                    className="text-[10px] rounded-md px-2 py-1"
                    style={{
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                    title="全量 OpenRouter 视频模型"
                  >
                    <option value="">更多…</option>
                    {OPENROUTER_VIDEO_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>

                {/* 时长 / 宽高 / 分辨率 */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px]" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}>
                    <Clock size={10} style={{ color: 'var(--text-muted)' }} />
                    <select
                      value={value.duration}
                      onChange={(e) => onChange({ duration: Number(e.target.value) })}
                      className="bg-transparent outline-none"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {[5, 8, 10, 12, 15].map((d) => (
                        <option key={d} value={d}>{d}s</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border-default)' }}>
                    {(['16:9', '9:16', '1:1'] as const).map((a) => {
                      const active = value.aspect === a;
                      return (
                        <button
                          key={a}
                          onClick={() => onChange({ aspect: a })}
                          className="px-2 py-1 text-[10px]"
                          style={{
                            background: active ? 'rgba(236,72,153,0.18)' : 'var(--bg-base)',
                            color: active ? '#f472b6' : 'var(--text-muted)',
                          }}
                        >
                          {a}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px]" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}>
                    <Maximize2 size={10} style={{ color: 'var(--text-muted)' }} />
                    <select
                      value={value.resolution}
                      onChange={(e) => onChange({ resolution: e.target.value as '480p' | '720p' | '1080p' })}
                      className="bg-transparent outline-none"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {(['480p', '720p', '1080p'] as const).map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* 分镜模式专属参数 */}
            {(value.routePreference === 'auto' || value.routePreference === 'remotion') && (
              <div
                className="flex flex-col gap-2 rounded-lg p-3"
                style={{ background: 'var(--panel)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="text-[11px] font-medium inline-flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                  <FileType2 size={11} /> 拆分镜参数（长内容 / 附件时生效）
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    系统提示词（旁白语言风格）
                  </label>
                  <textarea
                    value={value.systemPrompt}
                    onChange={(e) => onChange({ systemPrompt: e.target.value })}
                    rows={2}
                    placeholder="旁白语言活泼轻松，面向初学者…"
                    className="w-full rounded-md px-2 py-1.5 text-xs outline-none resize-none"
                    style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    画面风格
                  </label>
                  <input
                    value={value.styleDescription}
                    onChange={(e) => onChange({ styleDescription: e.target.value })}
                    placeholder="科技感、深色背景、霓虹色系…"
                    className="w-full rounded-md px-2 py-1.5 text-xs outline-none"
                    style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default UnifiedInputHero;
