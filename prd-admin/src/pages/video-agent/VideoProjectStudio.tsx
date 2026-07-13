import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  AudioLines,
  ChevronRight,
  FileText,
  Film,
  FolderOpen,
  Image,
  Library,
  Lock,
  Music2,
  Plus,
  Save,
  Sparkles,
  Subtitles,
  Upload,
  UserRound,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type {
  VideoGenRunListItem,
  VideoProject,
  VideoProjectAsset,
  VideoProjectAssetType,
  VideoProjectInput,
} from '@/services/contracts/videoAgent';
import { OPENROUTER_VIDEO_MODELS } from '@/services/contracts/videoAgent';
import { resolveVideoTitle } from './titleUtils';
import { VIDEO_STYLE_DEFINITIONS } from './videoStudioRegistry';
import './videoConsole.css';

type StudioTab = 'projects' | 'assets' | 'history';

interface VideoProjectStudioProps {
  projects: VideoProject[];
  project: VideoProject | null;
  runs: VideoGenRunListItem[];
  busy: boolean;
  onSelectProject: (project: VideoProject) => void;
  onNewProject: () => void;
  onSave: (input: VideoProjectInput) => Promise<VideoProject | null>;
  onAnalyze: (input: VideoProjectInput) => Promise<void>;
  onOpenRun: (runId: string) => void;
}

const TRACK_DEFINITIONS = [
  { type: 'video', label: '视频', icon: Film },
  { type: 'subtitle', label: '字幕', icon: Subtitles },
  { type: 'voice', label: '配音', icon: AudioLines },
  { type: 'music', label: '音乐', icon: Music2 },
] as const;

const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const ACCEPT_TEXT = '.md,.markdown,.txt,text/plain,text/markdown';

export const VideoProjectStudio: React.FC<VideoProjectStudioProps> = ({
  projects,
  project,
  runs,
  busy,
  onSelectProject,
  onNewProject,
  onSave,
  onAnalyze,
  onOpenRun,
}) => {
  const [tab, setTab] = useState<StudioTab>('projects');
  const [title, setTitle] = useState('');
  const [sourceMarkdown, setSourceMarkdown] = useState('');
  const [styleDescription, setStyleDescription] = useState('智能匹配');
  const [model, setModel] = useState('bytedance/seedance-2.0');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [resolution, setResolution] = useState('1080p');
  const [duration, setDuration] = useState(5);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [assets, setAssets] = useState<VideoProjectAsset[]>([]);
  const [assetType, setAssetType] = useState<VideoProjectAssetType>('character');
  const [assetName, setAssetName] = useState('');
  const [assetUrl, setAssetUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(project?.title === '未命名视频' ? '' : project?.title ?? '');
    setSourceMarkdown(project?.sourceMarkdown ?? '');
    setStyleDescription(project?.styleDescription ?? '智能匹配');
    setModel(project?.defaultVideoModel ?? 'bytedance/seedance-2.0');
    setAspectRatio(project?.defaultAspectRatio ?? '16:9');
    setResolution(project?.defaultResolution ?? '1080p');
    setDuration(project?.defaultDuration ?? 5);
    setGenerateAudio(project?.generateAudio ?? true);
    setAssets(project?.assets ?? []);
  }, [project]);

  const input = useMemo<VideoProjectInput>(() => ({
    title: title.trim() || undefined,
    sourceMarkdown,
    styleDescription,
    defaultVideoModel: model,
    defaultAspectRatio: aspectRatio,
    defaultResolution: resolution,
    defaultDuration: duration,
    generateAudio,
    assets,
  }), [aspectRatio, assets, duration, generateAudio, model, resolution, sourceMarkdown, styleDescription, title]);

  const estimatedShots = Math.max(1, Math.min(12, Math.ceil(sourceMarkdown.trim().length / 320)));
  const estimatedDuration = estimatedShots * duration;
  const selectedStyle = VIDEO_STYLE_DEFINITIONS.find((style) => style.label === styleDescription)
    ?? VIDEO_STYLE_DEFINITIONS[0];

  const readFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) return;
    const text = await file.text();
    setSourceMarkdown(text.trim());
    if (!title.trim()) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ''));
  };

  const addAsset = () => {
    if (!assetName.trim() || !assetUrl.trim()) return;
    setAssets((current) => [...current, {
      id: crypto.randomUUID().replaceAll('-', ''),
      type: assetType,
      name: assetName.trim(),
      url: assetUrl.trim(),
      createdAt: new Date().toISOString(),
    }]);
    setAssetName('');
    setAssetUrl('');
  };

  return (
    <div className="video-studio-page">
      <div className="video-console video-console--draft" data-testid="video-project-studio">
        <header className="video-console__header">
          <div className="video-console__project">
            <Film size={18} />
            <div className="min-w-0 flex-1">
              <input
                className="video-studio__title-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="未命名视频项目"
                aria-label="项目名称"
              />
              <div className="video-console__meta">{project ? '项目已保存' : '新项目'} · {sourceMarkdown.length.toLocaleString('zh-CN')} 字</div>
            </div>
          </div>
          <div className="video-console__phase">
            <span className="video-studio__health-dot" />
            <span>模型池在线</span>
            <span>Seedance 优先</span>
          </div>
          <div className="video-console__actions">
            <span className="video-studio__estimate">预计 {estimatedShots} 镜 · {estimatedDuration} 秒</span>
            <Button size="sm" variant="secondary" onClick={() => void onSave(input)} disabled={busy}>
              {busy ? <MapSpinner size={14} /> : <Save size={14} />} 保存
            </Button>
            <Button size="sm" variant="primary" onClick={() => void onAnalyze(input)} disabled={busy || !sourceMarkdown.trim()}>
              {busy ? <MapSpinner size={14} /> : <Sparkles size={14} />} 分析并拆镜
            </Button>
          </div>
        </header>

        <main className="video-console__workspace">
          <aside className="video-console__library" aria-label="项目与素材">
            <div className="video-studio__rail-tabs" role="tablist">
              <button className={tab === 'projects' ? 'is-active' : ''} onClick={() => setTab('projects')} title="项目"><FolderOpen size={15} /></button>
              <button className={tab === 'assets' ? 'is-active' : ''} onClick={() => setTab('assets')} title="素材"><Library size={15} /></button>
              <button className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')} title="生成历史"><Archive size={15} /></button>
            </div>
            <div className="video-console__panel-title">
              <div>{tab === 'projects' ? '视频项目' : tab === 'assets' ? '参考素材' : '生成历史'}</div>
              {tab === 'projects' && <button className="video-studio__small-icon" onClick={onNewProject} title="新建项目"><Plus size={14} /></button>}
            </div>
            <div className="video-console__library-scroll">
              {tab === 'projects' && (
                <>
                  <button className={`video-studio__project-row ${project === null ? 'is-active' : ''}`} onClick={onNewProject}>
                    <Plus size={15} /><div><strong>新视频项目</strong><span>从文学稿开始</span></div>
                  </button>
                  {projects.map((item) => (
                    <button key={item.id} className={`video-studio__project-row ${item.id === project?.id ? 'is-active' : ''}`} onClick={() => onSelectProject(item)}>
                      <Film size={15} /><div><strong>{item.title}</strong><span>{item.status} · {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span></div><ChevronRight size={13} />
                    </button>
                  ))}
                </>
              )}
              {tab === 'assets' && (
                <div className="video-studio__asset-list">
                  {assets.map((asset) => <div className="video-studio__asset" key={asset.id}>{asset.type === 'character' ? <UserRound size={15} /> : <Image size={15} />}<div><strong>{asset.name}</strong><span>{asset.type}</span></div></div>)}
                  {assets.length === 0 && <div className="video-console__library-empty"><Image size={22} /><strong>还没有参考素材</strong><span>在右侧添加角色、场景或道具参考，所有镜头会共享这些约束。</span></div>}
                </div>
              )}
              {tab === 'history' && (
                <div>
                  {runs.map((run) => (
                    <button key={run.id} className="video-studio__history-row" onClick={() => onOpenRun(run.id)}>
                      <div><strong>{resolveVideoTitle(run.articleTitle, run.createdAt, 28)}</strong><span>{run.status} · {new Date(run.createdAt).toLocaleString('zh-CN')}</span></div><ChevronRight size={13} />
                    </button>
                  ))}
                  {runs.length === 0 && <div className="video-console__library-empty"><Archive size={22} /><strong>暂无生成历史</strong></div>}
                </div>
              )}
            </div>
          </aside>

          <section className="video-console__viewer-column video-studio__source" aria-label="文学稿工作区">
            <div className="video-console__viewer-toolbar">
              <div><FileText size={14} /> 文学稿</div>
              <button className="video-studio__upload-button" onClick={() => fileInputRef.current?.click()}><Upload size={14} /> 上传文稿</button>
              <input ref={fileInputRef} type="file" accept={ACCEPT_TEXT} hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ''; }} />
            </div>
            <div className="video-studio__source-editor">
              <textarea
                value={sourceMarkdown}
                onChange={(event) => setSourceMarkdown(event.target.value)}
                placeholder="粘贴小说、散文、故事或脚本。系统会识别人物、场景、情绪和动作，生成可编辑镜头。"
                aria-label="文学稿内容"
              />
              {!sourceMarkdown && (
                <div className="video-studio__source-guide">
                  <FileText size={28} />
                  <strong>从一篇文学稿开始</strong>
                  <span>粘贴正文或上传 Markdown、TXT 文档，镜头、提示词和时间线会在当前制作台内生成。</span>
                </div>
              )}
            </div>
            <div className="video-studio__source-status"><span>{sourceMarkdown.length.toLocaleString('zh-CN')} 字</span><span>预计拆分 {estimatedShots} 个镜头</span><span>自动保存由项目服务管理</span></div>
          </section>

          <aside className="video-console__inspector" aria-label="项目控制器">
            <div className="video-console__panel-title"><div><Sparkles size={15} /> 项目控制器</div><span>GLOBAL</span></div>
            <div className="video-console__inspector-scroll">
              <div className="video-console__field"><span>视觉风格</span><div className="video-studio__style-grid">
                {VIDEO_STYLE_DEFINITIONS.map((style) => {
                  const Icon = style.icon;
                  return <button key={style.key} className={selectedStyle.key === style.key ? 'is-active' : ''} onClick={() => setStyleDescription(style.label)} title={style.description}><i style={{ background: style.color }} /><Icon size={14} /><span>{style.label}</span></button>;
                })}
              </div></div>
              <label className="video-console__field"><span>视频模型</span><select value={model} onChange={(event) => setModel(event.target.value)}>{OPENROUTER_VIDEO_MODELS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <div className="video-console__field"><span>画幅</span><div className="video-console__aspect-grid">{ASPECT_RATIOS.map((ratio) => <button key={ratio} className={aspectRatio === ratio ? 'is-active' : ''} onClick={() => setAspectRatio(ratio)}>{ratio}</button>)}</div></div>
              <div className="video-console__field-grid">
                <label className="video-console__field"><span>单镜时长</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>{[5, 8, 10, 12, 15].map((value) => <option key={value} value={value}>{value} 秒</option>)}</select></label>
                <label className="video-console__field"><span>分辨率</span><select value={resolution} onChange={(event) => setResolution(event.target.value)}><option>720p</option><option>1080p</option></select></label>
              </div>
              <label className="video-studio__switch"><div><Volume2 size={15} /><span>生成同步音频</span></div><input type="checkbox" checked={generateAudio} onChange={(event) => setGenerateAudio(event.target.checked)} /></label>
              <div className="video-studio__asset-form">
                <strong>添加参考素材</strong>
                <div className="video-console__field-grid"><select value={assetType} onChange={(event) => setAssetType(event.target.value as VideoProjectAssetType)}><option value="character">角色</option><option value="scene">场景</option><option value="prop">道具</option></select><input value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder="素材名称" /></div>
                <input value={assetUrl} onChange={(event) => setAssetUrl(event.target.value)} placeholder="公开图片或音频 URL" />
                <Button size="sm" variant="secondary" onClick={addAsset} disabled={!assetName.trim() || !assetUrl.trim()}><Plus size={13} /> 添加素材</Button>
              </div>
            </div>
          </aside>
        </main>

        <section className="video-console__timeline video-studio__timeline" aria-label="项目时间线">
          <div className="video-console__timeline-header"><div><Film size={14} /> 多轨时间线</div><span>{project?.timelineTracks.find((track) => track.type === 'video')?.clips.length ?? 0} 个片段 · {estimatedDuration} 秒</span></div>
          <div className="video-console__ruler">{[0, 5, 10, 15, 20, 25, 30].map((value) => <span key={value}>{value}s</span>)}</div>
          <div className="video-studio__tracks">
            {TRACK_DEFINITIONS.map((track) => { const Icon = track.icon; return <div className="video-studio__track" key={track.type}><div className="video-studio__track-label"><Icon size={13} /><span>{track.label}</span><Lock size={10} /></div><div className="video-studio__track-empty">{track.type === 'video' ? '拆镜后镜头会按顺序进入视频轨' : `添加${track.label}素材后可在这里编排`}</div></div>; })}
          </div>
        </section>
      </div>
    </div>
  );
};

export default VideoProjectStudio;
