import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  AudioLines,
  Film,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  Paperclip,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type {
  VideoGenRunListItem,
  VideoModelOption,
  VideoProject,
  VideoProjectAsset,
  VideoProjectAssetType,
  VideoProjectInput,
  VideoTimelineTrack,
} from '@/services/contracts/videoAgent';
import { resolveVideoTitle } from './titleUtils';
import { VIDEO_STYLE_DEFINITIONS } from './videoStudioRegistry';
import './videoConsole.css';

interface VideoProjectStudioProps {
  projects: VideoProject[];
  project: VideoProject | null;
  runs: VideoGenRunListItem[];
  models: VideoModelOption[];
  busy: boolean;
  onSelectProject: (project: VideoProject) => void;
  onNewProject: () => void;
  onSave: (input: VideoProjectInput) => Promise<VideoProject | null>;
  onAnalyze: (input: VideoProjectInput) => Promise<void>;
  onOpenRun: (runId: string) => void;
}

const ACCEPT_TEXT = '.md,.markdown,.txt,text/plain,text/markdown';

const ACTIVE_RUN_STATUSES = new Set(['Queued', 'Scripting', 'Editing', 'Rendering']);

const STATUS_LABELS: Record<string, string> = {
  Draft: '草稿',
  Analyzing: '拆镜中',
  Editing: '待编辑',
  Queued: '排队中',
  Scripting: '拆镜中',
  Rendering: '生成中',
  Completed: '已完成',
};

const statusLabel = (status: string) => STATUS_LABELS[status] ?? '处理中';

const runSubtitle = (run: VideoGenRunListItem) => {
  if (run.status === 'Queued') return '等待开始生成';
  if (run.status === 'Scripting') return '正在拆分镜头';
  if (run.status === 'Completed' && run.scenesCount === 0) return '视频已生成';
  if (run.scenesCount === 0) return '镜头准备中';
  return `${run.scenesReady}/${run.scenesCount} 镜头`;
};

interface ProjectCoverProps {
  mediaUrl?: string;
  status: string;
}

const ProjectCover: React.FC<ProjectCoverProps> = ({ mediaUrl, status }) => (
  <span className="video-create-project-cover">
    <span className="video-create-project-placeholder"><Film size={24} /><span>视频作品</span></span>
    {mediaUrl && (
      <img src={mediaUrl} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />
    )}
    <i>{statusLabel(status)}</i>
  </span>
);

const createTimelineTracks = (): VideoTimelineTrack[] => [
  { id: crypto.randomUUID().replaceAll('-', ''), type: 'video', name: '视频', muted: false, locked: false, clips: [] },
  { id: crypto.randomUUID().replaceAll('-', ''), type: 'subtitle', name: '字幕', muted: false, locked: false, clips: [] },
  { id: crypto.randomUUID().replaceAll('-', ''), type: 'voice', name: '配音', muted: false, locked: false, clips: [] },
  { id: crypto.randomUUID().replaceAll('-', ''), type: 'music', name: '音乐', muted: false, locked: false, clips: [] },
];

export const VideoProjectStudio: React.FC<VideoProjectStudioProps> = ({
  projects,
  project,
  runs,
  models,
  busy,
  onSelectProject,
  onNewProject,
  onSave,
  onAnalyze,
  onOpenRun,
}) => {
  const [title, setTitle] = useState('');
  const [sourceMarkdown, setSourceMarkdown] = useState('');
  const [styleDescription, setStyleDescription] = useState('智能匹配');
  const [model, setModel] = useState(() => models.find((item) => item.healthStatus !== 'Unavailable')?.id ?? '');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [resolution, setResolution] = useState('1080p');
  const [duration, setDuration] = useState(5);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [assets, setAssets] = useState<VideoProjectAsset[]>([]);
  const [timelineTracks, setTimelineTracks] = useState<VideoTimelineTrack[]>(createTimelineTracks);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<'create' | 'works'>('create');
  const [assetType, setAssetType] = useState<VideoProjectAssetType>('character');
  const [assetName, setAssetName] = useState('');
  const [assetUrl, setAssetUrl] = useState('');
  const [assetDescription, setAssetDescription] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const recentWorkRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setTitle(project?.title === '未命名视频' ? '' : project?.title ?? '');
    setSourceMarkdown(project?.sourceMarkdown ?? '');
    setStyleDescription(project?.styleDescription ?? '智能匹配');
    const savedModel = project?.defaultVideoModel;
    setModel(savedModel && models.some((item) => item.id === savedModel)
      ? savedModel
      : models.find((item) => item.healthStatus !== 'Unavailable')?.id ?? '');
    setAspectRatio(project?.defaultAspectRatio ?? '16:9');
    setResolution(project?.defaultResolution ?? '1080p');
    setDuration(project?.defaultDuration ?? 5);
    setGenerateAudio(project?.generateAudio ?? true);
    setAssets(project?.assets ?? []);
    setTimelineTracks(project?.timelineTracks?.length ? project.timelineTracks : createTimelineTracks());
  }, [project, models]);

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
    timelineTracks,
  }), [aspectRatio, assets, duration, generateAudio, model, resolution, sourceMarkdown, styleDescription, timelineTracks, title]);

  const selectedModel = models.find((item) => item.id === model);
  const selectedStyle = VIDEO_STYLE_DEFINITIONS.find((style) => style.label === styleDescription)
    ?? VIDEO_STYLE_DEFINITIONS[0];
  const estimatedShots = Math.max(1, Math.min(16, Math.ceil(sourceMarkdown.trim().length / 320)));
  const estimatedDuration = estimatedShots * duration;
  const availableAspectRatios = selectedModel?.aspectRatios.length ? selectedModel.aspectRatios : ['16:9'];
  const availableDurations = selectedModel?.durations.length ? selectedModel.durations : [5];
  const availableResolutions = selectedModel?.resolutions.length ? selectedModel.resolutions : ['720p'];
  const recentRuns = runs
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status) || (run.status === 'Completed' && Boolean(run.videoAssetUrl)))
    .slice(0, 6);
  const recentWorkCount = projects.length + recentRuns.length;

  const readFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) return;
    const text = await file.text();
    setSourceMarkdown(text.trim());
    if (!title.trim()) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ''));
  };

  const selectModel = (nextModelId: string) => {
    const option = models.find((item) => item.id === nextModelId);
    setModel(nextModelId);
    if (!option) return;
    if (!option.aspectRatios.includes(aspectRatio)) setAspectRatio(option.aspectRatios[0] ?? '16:9');
    if (!option.resolutions.includes(resolution)) setResolution(option.resolutions[0] ?? '720p');
    if (!option.durations.includes(duration)) setDuration(option.durations[0] ?? 5);
    if (!option.supportsAudio) setGenerateAudio(false);
  };

  const addAsset = () => {
    if (!assetName.trim() || !assetUrl.trim()) return;
    setAssets((current) => [...current, {
      id: crypto.randomUUID().replaceAll('-', ''),
      type: assetType,
      name: assetName.trim(),
      url: assetUrl.trim(),
      description: assetDescription.trim() || undefined,
      createdAt: new Date().toISOString(),
    }]);
    setAssetName('');
    setAssetUrl('');
    setAssetDescription('');
  };

  const coverForProject = (item: VideoProject) => item.assets.find((asset) => asset.type !== 'audio' && asset.url)?.url;

  const scrollToSection = (section: 'create' | 'works') => {
    setActiveSection(section);
    const top = section === 'create' ? 0 : recentWorkRef.current?.offsetTop ?? 0;
    scrollRef.current?.scrollTo({ top, behavior: 'smooth' });
  };

  const syncActiveSection = () => {
    const container = scrollRef.current;
    const recentWork = recentWorkRef.current;
    if (!container || !recentWork) return;
    const worksThreshold = Math.max(0, recentWork.offsetTop - container.clientHeight * 0.35);
    const nextSection = container.scrollTop >= worksThreshold ? 'works' : 'create';
    setActiveSection((current) => current === nextSection ? current : nextSection);
  };

  return (
    <div className="video-create-page" data-testid="video-project-studio">
      <header className="video-create-nav">
        <button className="video-create-brand" onClick={onNewProject}>
          <span><Film size={17} /></span>
          <div><strong>视频创作</strong><small>Seedance Studio</small></div>
        </button>
        <nav className="video-create-nav-tabs" aria-label="视频创作页面">
          <button className={activeSection === 'create' ? 'is-active' : ''} aria-current={activeSection === 'create' ? 'location' : undefined} onClick={() => scrollToSection('create')}>创作</button>
          <button className={activeSection === 'works' ? 'is-active' : ''} aria-current={activeSection === 'works' ? 'location' : undefined} onClick={() => scrollToSection('works')}>作品</button>
        </nav>
        <div className="video-create-nav-actions">
          <button className="video-create-text-button" onClick={onNewProject}><Plus size={15} /> 新项目</button>
          <button className="video-create-icon-button" onClick={() => void onSave(input)} disabled={busy} title="保存草稿"><Save size={16} /></button>
        </div>
      </header>

      <main ref={scrollRef} className="video-create-scroll" onScroll={syncActiveSection}>
        <section className="video-create-stage" aria-label="创建视频项目">
          <div className="video-create-heading">
            <span>文学创作转视频</span>
            <h1>把一个故事变成一组镜头</h1>
          </div>

          <div className="video-create-composer">
            <input
              className="video-create-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="给这部作品起个名字"
              aria-label="项目名称"
            />
            <textarea
              value={sourceMarkdown}
              onChange={(event) => setSourceMarkdown(event.target.value)}
              placeholder="粘贴小说、散文、故事或脚本"
              aria-label="文学稿内容"
            />

            {assets.length > 0 && (
              <div className="video-create-reference-chips" aria-label="已选参考素材">
                {assets.map((asset) => (
                  <div key={asset.id} className="video-create-reference-chip">
                    {asset.type === 'audio' ? <AudioLines size={13} /> : asset.url ? <img src={asset.url} alt="" /> : <ImageIcon size={13} />}
                    <span>{asset.name}</span>
                    <button onClick={() => setAssets((current) => current.filter((item) => item.id !== asset.id))} aria-label={`移除${asset.name}`}><Trash2 size={11} /></button>
                  </div>
                ))}
              </div>
            )}

            <div className="video-create-composer-toolbar">
              <div>
                <button className="video-create-tool" onClick={() => fileInputRef.current?.click()} title="上传文稿"><Paperclip size={16} /><span>文稿</span></button>
                <input ref={fileInputRef} type="file" accept={ACCEPT_TEXT} hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ''; }} />
                <button className={`video-create-tool ${referencesOpen ? 'is-active' : ''}`} onClick={() => setReferencesOpen((value) => !value)}><ImagePlus size={16} /><span>参考</span></button>
                <button className={`video-create-tool ${settingsOpen ? 'is-active' : ''}`} onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={16} /><span>设置</span></button>
              </div>
              <Button variant="primary" onClick={() => void onAnalyze(input)} disabled={busy || !sourceMarkdown.trim() || !model}>
                {busy ? <MapSpinner size={15} /> : <Sparkles size={15} />}
                AI 拆成分镜
              </Button>
            </div>
          </div>

          <div className="video-create-presets" aria-label="视觉风格">
            {VIDEO_STYLE_DEFINITIONS.slice(0, 6).map((style) => {
              const Icon = style.icon;
              return (
                <button key={style.key} className={selectedStyle.key === style.key ? 'is-active' : ''} onClick={() => setStyleDescription(style.label)}>
                  <i style={{ background: style.color }} />
                  <Icon size={14} />
                  <span>{style.label}</span>
                </button>
              );
            })}
          </div>

          <div className="video-create-estimate">
            <span>{sourceMarkdown.length.toLocaleString('zh-CN')} 字</span>
            <span>预计 {estimatedShots} 个镜头</span>
            <span>约 {estimatedDuration} 秒</span>
          </div>

          {referencesOpen && (
            <section className="video-create-options" aria-label="添加参考素材">
              <div className="video-create-options-heading"><div><ImagePlus size={16} /><strong>角色与场景参考</strong></div><span>最多向支持的模型传入 9 张参考图</span></div>
              <div className="video-create-reference-form">
                <select value={assetType} onChange={(event) => setAssetType(event.target.value as VideoProjectAssetType)} aria-label="素材类型">
                  <option value="character">角色</option><option value="scene">场景</option><option value="prop">道具</option><option value="audio">音频</option>
                </select>
                <input value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder="素材名称" aria-label="素材名称" />
                <input className="is-wide" value={assetUrl} onChange={(event) => setAssetUrl(event.target.value)} placeholder="粘贴公开素材 URL" aria-label="公开素材 URL" />
                <input className="is-wide" value={assetDescription} onChange={(event) => setAssetDescription(event.target.value)} placeholder="外观、服装、场景或使用约束" aria-label="素材约束" />
                <Button size="sm" variant="secondary" onClick={addAsset} disabled={!assetName.trim() || !assetUrl.trim()}><Plus size={13} /> 添加</Button>
              </div>
            </section>
          )}

          {settingsOpen && (
            <section className="video-create-options" aria-label="生成设置">
              <div className="video-create-options-heading"><div><Settings2 size={16} /><strong>生成设置</strong></div><span>所有镜头的默认值，拆镜后仍可逐镜调整</span></div>
              <div className="video-create-settings-grid">
                <label><span>视频模型</span><select value={model} onChange={(event) => selectModel(event.target.value)} disabled={models.length === 0}><option value="">选择模型</option>{models.map((item) => <option key={item.id} value={item.id} disabled={item.healthStatus === 'Unavailable'}>{item.name}</option>)}</select></label>
                <label><span>画幅</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{availableAspectRatios.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label><span>单镜时长</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>{availableDurations.map((value) => <option key={value} value={value}>{value} 秒</option>)}</select></label>
                <label><span>分辨率</span><select value={resolution} onChange={(event) => setResolution(event.target.value)}>{availableResolutions.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label className="video-create-audio-toggle"><span>同步音频</span><input type="checkbox" checked={generateAudio} disabled={!selectedModel?.supportsAudio} onChange={(event) => setGenerateAudio(event.target.checked)} /></label>
              </div>
            </section>
          )}
        </section>

        <section ref={recentWorkRef} id="video-recent-work" className="video-create-library" aria-label="最近作品">
          <div className="video-create-section-heading"><div><FolderOpen size={16} /><strong>最近作品</strong></div><span>{recentWorkCount} 个作品</span></div>
          {recentWorkCount > 0 ? (
            <div className="video-create-project-grid">
              {projects.slice(0, 6).map((item) => (
                <button key={item.id} className={item.id === project?.id ? 'is-active' : ''} onClick={() => onSelectProject(item)}>
                  <ProjectCover mediaUrl={coverForProject(item)} status={item.status} />
                  <span className="video-create-project-copy"><strong>{resolveVideoTitle(item.title, item.updatedAt, 28)}</strong><small>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</small></span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
              {recentRuns.slice(0, Math.max(0, 6 - projects.length)).map((run) => (
                <button key={run.id} onClick={() => onOpenRun(run.id)}>
                  <ProjectCover status={run.status} />
                  <span className="video-create-project-copy"><strong>{resolveVideoTitle(run.articleTitle, run.createdAt, 28)}</strong><small>{runSubtitle(run)}</small></span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            </div>
          ) : (
            <div className="video-create-empty-library">
              <Film size={22} />
              <div><strong>还没有作品</strong><span>第一部作品会保存在这里</span></div>
              <button onClick={() => scrollToSection('create')}>开始创作</button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default VideoProjectStudio;
