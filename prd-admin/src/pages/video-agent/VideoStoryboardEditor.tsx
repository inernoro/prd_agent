import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Columns2,
  ChevronRight,
  Clock3,
  CircleStop,
  Download,
  Film,
  GripVertical,
  History,
  Image as ImageIcon,
  Layers3,
  Maximize2,
  PanelRightOpen,
  Pause,
  Play,
  RefreshCw,
  Save,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { connectSse } from '@/lib/useSseStream';
import {
  activateVideoSceneVersionReal,
  cancelVideoGenRunReal,
  exportVideoGenRunReal,
  getVideoGenStreamUrl,
  getVideoGenRunReal,
  getVideoProjectReal,
  listVideoModelsReal,
  regenerateVideoSceneReal,
  reorderVideoScenesReal,
  renderVideoSceneReal,
  renderVideoScenesReal,
  updateVideoSceneReal,
} from '@/services/real/videoAgent';
import {
  type SceneItemStatus,
  type VideoGenRun,
  type VideoGenScene,
  type VideoGenSceneVersion,
  type VideoModelOption,
  type VideoProject,
  type VideoProjectAsset,
  type VideoTimelineTrack,
} from '@/services/contracts/videoAgent';
import './videoConsole.css';

export interface VideoStoryboardEditorProps {
  runId: string;
  onBack?: () => void;
}

type PreviewMode = 'scene' | 'compare' | 'export';

const DURATIONS = [5, 8, 10, 12, 15];
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'];
const RESOLUTIONS = ['480p', '720p', '1080p'];

const SCENE_STATUS_REGISTRY: Record<SceneItemStatus, { label: string; color: string }> = {
  Draft: { label: '待生成', color: 'var(--text-muted)' },
  Generating: { label: '改写中', color: '#a78bfa' },
  Rendering: { label: '生成中', color: '#38bdf8' },
  Done: { label: '已就绪', color: '#34d399' },
  Error: { label: '需重试', color: '#fb7185' },
};

const PHASE_LABELS: Record<string, string> = {
  queued: '任务排队中',
  scripting: '正在分析文学稿并拆分镜头',
  editing: '镜头可编辑',
  'export-queued': '导出任务排队中',
  'export-preparing': '正在准备素材',
  'export-downloading': '正在汇集镜头素材',
  'export-composing': '正在合成完整视频',
  'export-uploading': '正在上传成片',
  'export-failed': '导出失败，可修改后重试',
  completed: '成片已就绪',
};

export const VideoStoryboardEditor: React.FC<VideoStoryboardEditorProps> = ({ runId, onBack }) => {
  const [run, setRun] = useState<VideoGenRun | null>(null);
  const [models, setModels] = useState<VideoModelOption[]>([]);
  const [project, setProject] = useState<VideoProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSceneIndex, setSelectedSceneIndex] = useState(0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('scene');
  const [compareVersionIds, setCompareVersionIds] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');
  const [topicDraft, setTopicDraft] = useState('');
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [mutating, setMutating] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadRunRef = useRef<(() => Promise<void>) | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const autoSelectedExportRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (!pollRef.current) return;
    clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => { void loadRunRef.current?.(); }, 2500);
  }, []);

  const loadRun = useCallback(async () => {
    try {
      const response = await getVideoGenRunReal(runId);
      if (!response.success || !response.data) {
        setError(response.error?.message || '加载视频项目失败');
        return;
      }

      setRun(response.data);
      setError(null);
      setSelectedSceneIndex((current) => Math.min(current, Math.max(response.data.scenes.length - 1, 0)));
      const hasTransientScene = response.data.scenes.some(
        (scene) => scene.status === 'Generating' || scene.status === 'Rendering',
      );
      const hasTransientRun = ['Queued', 'Scripting', 'Rendering'].includes(response.data.status);
      if (!hasTransientScene && !hasTransientRun) stopPolling();

      if (response.data.status === 'Completed' && response.data.videoAssetUrl) {
        if (!autoSelectedExportRef.current) {
          autoSelectedExportRef.current = true;
          setPreviewMode('export');
        }
      } else {
        autoSelectedExportRef.current = false;
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '网络错误');
    }
  }, [runId, stopPolling]);

  useEffect(() => { loadRunRef.current = loadRun; }, [loadRun]);
  useEffect(() => {
    void loadRun();
    return () => stopPolling();
  }, [loadRun, stopPolling]);

  useEffect(() => {
    void listVideoModelsReal().then((response) => {
      if (response.success) setModels(response.data);
    });
  }, []);

  useEffect(() => {
    if (!run?.projectId) { setProject(null); return; }
    void getVideoProjectReal(run.projectId).then((response) => {
      if (response.success) setProject(response.data);
    });
  }, [run?.projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void connectSse({
      url: getVideoGenStreamUrl(runId),
      signal: controller.signal,
      onEvent: () => { void loadRunRef.current?.(); },
    }).then((result) => {
      if (!result.success && !controller.signal.aborted) startPolling();
    });
    return () => controller.abort();
  }, [runId, startPolling]);

  const selectedScene = run?.scenes[selectedSceneIndex] ?? null;
  const selectedSceneWorking = selectedScene?.status === 'Rendering' || selectedScene?.status === 'Generating';
  const selectedSceneEditable = Boolean(selectedScene)
    && (run?.status === 'Editing' || run?.status === 'Completed')
    && !selectedSceneWorking;
  const pendingScenes = useMemo(
    () => run?.scenes.filter((scene) => scene.status === 'Draft' || scene.status === 'Error') ?? [],
    [run],
  );
  const allScenesReady = Boolean(
    run?.scenes.length && run.scenes.every((scene) => scene.status === 'Done' && scene.videoUrl),
  );
  const totalCost = useMemo(
    () => run?.scenes.reduce((sum, scene) => sum + (scene.cost ?? 0), 0) ?? 0,
    [run],
  );
  const totalDuration = useMemo(
    () => run?.scenes.reduce((sum, scene) => sum + (scene.duration ?? run.directDuration ?? 5), 0) ?? 0,
    [run],
  );
  const previewUrl = previewMode === 'export'
    ? run?.videoAssetUrl
    : selectedScene?.videoUrl;
  const compareVersions = selectedScene?.versions.filter((version) => compareVersionIds.includes(version.id)) ?? [];

  useEffect(() => { setCompareVersionIds([]); }, [selectedSceneIndex]);
  useEffect(() => { setPromptDraft(selectedScene?.prompt ?? ''); }, [selectedScene?.prompt, selectedSceneIndex]);
  useEffect(() => { setTopicDraft(selectedScene?.topic ?? ''); }, [selectedScene?.topic, selectedSceneIndex]);

  const mutate = useCallback(async (key: string, action: () => Promise<boolean>) => {
    if (mutating) return;
    setMutating(key);
    try {
      const success = await action();
      if (success) {
        startPolling();
        await loadRun();
      }
    } finally {
      setMutating(null);
    }
  }, [loadRun, mutating, startPolling]);

  const updateScene = useCallback(async (patch: Parameters<typeof updateVideoSceneReal>[2]) => {
    if (!selectedScene) return false;
    const response = await updateVideoSceneReal(runId, selectedSceneIndex, patch);
    if (!response.success) {
      toast.error('保存镜头失败', response.error?.message);
      return false;
    }
    return true;
  }, [runId, selectedScene, selectedSceneIndex]);

  const saveScenePatch = useCallback((patch: Parameters<typeof updateVideoSceneReal>[2]) => mutate('save-scene', async () => {
    const success = await updateScene(patch);
    if (success) toast.success('镜头参数已保存');
    return success;
  }), [mutate, updateScene]);

  const renderScene = useCallback(() => mutate('render-scene', async () => {
    if (!selectedScene) return false;
    const nextPrompt = promptDraft.trim();
    if (!nextPrompt) return false;
    if (nextPrompt !== selectedScene.prompt) {
      const saved = await updateScene({ prompt: nextPrompt });
      if (!saved) return false;
    }
    const response = await renderVideoSceneReal(runId, selectedSceneIndex);
    if (!response.success) {
      toast.error('提交生成失败', response.error?.message);
      return false;
    }
    toast.success('镜头已进入生成队列');
    return true;
  }), [mutate, promptDraft, runId, selectedScene, selectedSceneIndex, updateScene]);

  const regenerateScene = useCallback(() => mutate('regenerate-scene', async () => {
    const response = await regenerateVideoSceneReal(runId, selectedSceneIndex);
    if (!response.success) {
      toast.error('改写镜头失败', response.error?.message);
      return false;
    }
    return true;
  }), [mutate, runId, selectedSceneIndex]);

  const renderBatch = useCallback(() => mutate('render-batch', async () => {
    const response = await renderVideoScenesReal(runId);
    if (!response.success) {
      toast.error('批量生成失败', response.error?.message);
      return false;
    }
    setBatchDialogOpen(false);
    toast.success(`已提交 ${response.data?.count ?? 0} 个镜头`);
    return true;
  }), [mutate, runId]);

  const exportRun = useCallback(() => mutate('export', async () => {
    const response = await exportVideoGenRunReal(runId);
    if (!response.success) {
      toast.error('导出失败', response.error?.message);
      return false;
    }
    setPreviewMode('export');
    toast.success('完整视频已进入导出队列');
    return true;
  }), [mutate, runId]);

  const cancelRun = useCallback(() => mutate('cancel-run', async () => {
    const response = await cancelVideoGenRunReal(runId);
    if (!response.success) {
      toast.error('停止任务失败', response.error?.message);
      return false;
    }
    toast.success('已请求停止后台任务');
    return true;
  }), [mutate, runId]);

  const activateVersion = useCallback((version: VideoGenSceneVersion) => mutate('activate-version', async () => {
    const response = await activateVideoSceneVersionReal(runId, selectedSceneIndex, version.id);
    if (!response.success) {
      toast.error('切换版本失败', response.error?.message);
      return false;
    }
    setPreviewMode('scene');
    return true;
  }), [mutate, runId, selectedSceneIndex]);

  const toggleCompareVersion = useCallback((version: VideoGenSceneVersion) => {
    setCompareVersionIds((current) => {
      const next = current.includes(version.id)
        ? current.filter((id) => id !== version.id)
        : [...current.slice(-1), version.id];
      setPreviewMode(next.length === 2 ? 'compare' : 'scene');
      return next;
    });
  }, []);

  const reorderScenes = useCallback((fromIndex: number, toIndex: number) => mutate('reorder-scenes', async () => {
    if (!run || fromIndex === toIndex) return false;
    const indexes = run.scenes.map((_, index) => index);
    const [moved] = indexes.splice(fromIndex, 1);
    indexes.splice(toIndex, 0, moved);
    const response = await reorderVideoScenesReal(runId, indexes);
    if (!response.success) {
      toast.error('调整镜头顺序失败', response.error?.message);
      return false;
    }
    setSelectedSceneIndex(toIndex);
    return true;
  }), [mutate, run, runId]);

  const togglePlayback = useCallback(() => {
    const player = videoRef.current;
    if (!player || !previewUrl) return;
    if (player.paused) void player.play();
    else player.pause();
  }, [previewUrl]);

  if (error) {
    return (
      <div className="video-console-state">
        <AlertCircle size={32} />
        <strong>项目加载失败</strong>
        <span>{error}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => void loadRun()}>重试</Button>
          {onBack && <Button size="sm" variant="ghost" onClick={onBack}>返回列表</Button>}
        </div>
      </div>
    );
  }

  if (!run) return <MapSectionLoader text="正在打开视频项目" />;

  if (run.status === 'Queued' || run.status === 'Scripting') {
    return (
      <div className="video-console-state">
        <MapSpinner size={34} />
        <strong>{PHASE_LABELS[run.currentPhase] || '正在创建视频项目'}</strong>
        <span>文学稿正在转化为可编辑镜头，生成完成后会自动进入制作台。</span>
        <ProgressBar progress={run.phaseProgress} />
        {onBack && <Button size="sm" variant="ghost" onClick={onBack}>返回列表</Button>}
      </div>
    );
  }

  return (
    <div className={`video-console video-workbench ${editMode ? 'is-editing' : ''}`} aria-label="视频制作控制台" data-testid="video-console">
      <header className="video-workbench__header">
        <div className="video-workbench__project">
          {onBack && (
            <button className="video-workbench__icon-button" onClick={onBack} aria-label="返回作品列表" title="返回作品列表">
              <ArrowLeft size={17} />
            </button>
          )}
          <div className="min-w-0">
            <div className="video-workbench__title">{run.articleTitle || '未命名视频项目'}</div>
            <div className="video-workbench__meta">{run.scenes.length} 个镜头 · {totalDuration} 秒 · ${totalCost.toFixed(3)}</div>
          </div>
        </div>

        <div className="video-workbench__phase" aria-live="polite">
          {run.status === 'Rendering' && <MapSpinner size={14} />}
          <span>{PHASE_LABELS[run.currentPhase] || run.currentPhase}</span>
          {run.status === 'Rendering' && <span>{run.phaseProgress}%</span>}
        </div>

        <div className="video-workbench__actions">
          {['Queued', 'Scripting', 'Rendering'].includes(run.status) && (
            <Button size="sm" variant="secondary" onClick={cancelRun} disabled={mutating === 'cancel-run'}>
              {mutating === 'cancel-run' ? <MapSpinner size={14} /> : <CircleStop size={14} />} 停止任务
            </Button>
          )}
          {pendingScenes.length > 0 && run.status === 'Editing' && (
            <Button size="sm" variant="secondary" onClick={() => setBatchDialogOpen(true)}>
              <Layers3 size={14} /> 批量生成
            </Button>
          )}
          <button className={`video-workbench__mode-button ${settingsOpen ? 'is-active' : ''}`} onClick={() => setSettingsOpen((value) => !value)}><PanelRightOpen size={15} /> 镜头设置</button>
          <button className={`video-workbench__mode-button ${editMode ? 'is-active' : ''}`} onClick={() => setEditMode((value) => !value)} disabled={!allScenesReady} title={allScenesReady ? '打开成片剪辑' : '所有镜头生成后可进入剪辑'}><Scissors size={15} /> {editMode ? '退出剪辑' : '剪辑成片'}</button>
          {editMode && (
            <Button size="sm" variant="primary" onClick={exportRun} disabled={run.status !== 'Editing' || mutating === 'export'}>
              {mutating === 'export' ? <MapSpinner size={14} /> : <Film size={14} />} 导出
            </Button>
          )}
          {run.videoAssetUrl && (
            <a className="video-workbench__download" href={run.videoAssetUrl} target="_blank" rel="noreferrer">
              <Download size={14} /> 下载
            </a>
          )}
        </div>
      </header>

      {run.exportErrorMessage && (
        <div className="video-console__alert" role="alert">
          <AlertCircle size={15} />
          <span>{run.exportErrorMessage}</span>
          <button onClick={exportRun} disabled={!allScenesReady}>重新导出</button>
        </div>
      )}

      <main className={`video-workbench__workspace ${settingsOpen ? 'has-inspector' : ''}`} data-testid="video-console-workspace">
        <aside className="video-workbench__filmstrip" aria-label="分镜胶片带">
          <div className="video-workbench__filmstrip-heading"><Film size={14} /><span>镜头</span><strong>{run.scenes.length}</strong></div>
          <div className="video-workbench__filmstrip-scroll">
            {run.scenes.length > 0 ? run.scenes.map((scene, index) => (
              <SceneLibraryItem
                key={scene.index}
                scene={scene}
                index={index}
                active={index === selectedSceneIndex && previewMode === 'scene'}
                onClick={() => {
                  setSelectedSceneIndex(index);
                  setPreviewMode('scene');
                }}
              />
            )) : <EmptyLibrary />}
          </div>
        </aside>

        <section className="video-workbench__creative" aria-label="视频预览与生成">
          <div className="video-workbench__viewer-toolbar">
            <div className="video-console__segmented" role="group" aria-label="预览模式">
              <button className={previewMode === 'scene' ? 'is-active' : ''} onClick={() => setPreviewMode('scene')}>当前镜头</button>
              <button
                className={previewMode === 'compare' ? 'is-active' : ''}
                onClick={() => setPreviewMode('compare')}
                disabled={compareVersions.length !== 2}
              >
                版本比较
              </button>
              <button
                className={previewMode === 'export' ? 'is-active' : ''}
                onClick={() => setPreviewMode('export')}
                disabled={!run.videoAssetUrl && run.status !== 'Rendering'}
              >
                完整成片
              </button>
            </div>
            <span>{previewMode === 'scene' ? selectedScene?.topic : previewMode === 'compare' ? '版本并排比较' : '最终导出'}</span>
          </div>

          <div className="video-workbench__viewer">
            {previewMode === 'compare' ? (
              compareVersions.length === 2 ? (
                <div className="video-console__compare-grid">
                  {compareVersions.map((version, index) => (
                    <div key={version.id}>
                      <video src={version.videoUrl} controls playsInline />
                      <span>版本 {selectedScene ? selectedScene.versions.findIndex((item) => item.id === version.id) + 1 : index + 1} · {version.model || '模型池自动选择'}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="video-console__viewer-empty">
                  <Columns2 size={30} />
                  <strong>选择两个版本进行比较</strong>
                  <span>在下方版本带选择两个生成结果。</span>
                </div>
              )
            ) : previewUrl ? (
              <video
                key={previewUrl}
                ref={videoRef}
                src={previewUrl}
                aria-label={previewMode === 'export' ? '完整成片预览' : `${selectedScene?.topic || '当前镜头'}预览`}
                controls={false}
                playsInline
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime)}
                onEnded={() => setIsPlaying(false)}
              />
            ) : run.status === 'Rendering' && previewMode === 'export' ? (
              <ViewerProgress run={run} />
            ) : selectedScene?.status === 'Rendering' || selectedScene?.status === 'Generating' ? (
              <ViewerProgress run={run} label={SCENE_STATUS_REGISTRY[selectedScene.status].label} />
            ) : (
              <div className="video-console__viewer-empty">
                <WandSparkles size={32} />
                <strong>{selectedScene ? '这个镜头还没有视频' : '还没有可预览镜头'}</strong>
                <span>{selectedScene ? '在下方描述镜头动作，然后生成。' : '返回作品页重新创建分镜项目。'}</span>
              </div>
            )}
          </div>

          <div className="video-workbench__transport">
            <button onClick={togglePlayback} disabled={!previewUrl || previewMode === 'compare'} aria-label={isPlaying ? '暂停' : '播放'}>
              {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <span>{formatTime(playhead)}</span>
            <div className="video-console__transport-line"><i style={{ width: `${getPlaybackPercent(videoRef.current)}%` }} /></div>
            <span>{formatTime(videoRef.current?.duration || selectedScene?.duration || 0)}</span>
            <button aria-label="适应画布" title="适应画布"><Maximize2 size={15} /></button>
          </div>

          {selectedScene && (
            <section className="video-workbench__composer" aria-label="镜头生成">
              <input
                className="video-workbench__topic-input"
                value={topicDraft}
                onChange={(event) => setTopicDraft(event.target.value)}
                onBlur={() => {
                  const next = topicDraft.trim();
                  if (next && next !== selectedScene.topic) void saveScenePatch({ topic: next });
                }}
                disabled={!selectedSceneEditable}
                aria-label="镜头名称"
              />
              <textarea
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
                placeholder="描述人物动作、镜头运动和环境变化"
                disabled={!selectedSceneEditable}
                aria-label="生成提示词"
              />
              {(project?.assets.length ?? 0) > 0 && (
                <div className="video-workbench__reference-row">
                  {project?.assets.filter((asset) => asset.type !== 'audio').slice(0, 9).map((asset) => (
                    <span key={asset.id}>{asset.url ? <img src={asset.url} alt="" /> : <ImageIcon size={13} />}{asset.name}</span>
                  ))}
                </div>
              )}
              <div className="video-workbench__composer-actions">
                <div>
                  <button onClick={regenerateScene} disabled={!selectedSceneEditable || Boolean(mutating)}>{mutating === 'regenerate-scene' ? <MapSpinner size={13} /> : <RefreshCw size={13} />} AI 改写</button>
                  <button onClick={() => void saveScenePatch({ prompt: promptDraft.trim() })} disabled={!selectedSceneEditable || !promptDraft.trim() || promptDraft.trim() === selectedScene.prompt}><Save size={13} /> 保存</button>
                  <button onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={13} /> 参数</button>
                </div>
                <Button variant="primary" onClick={renderScene} disabled={!selectedSceneEditable || Boolean(mutating) || !promptDraft.trim()}>
                  {mutating === 'render-scene' || selectedSceneWorking ? <MapSpinner size={14} /> : <Sparkles size={14} />}
                  {selectedScene.videoUrl ? '生成新版本' : '生成这个镜头'}
                </Button>
              </div>
            </section>
          )}

          <section className="video-workbench__versions" aria-label="生成版本">
            <div className="video-workbench__versions-heading"><div><strong>生成版本</strong><span>{selectedScene?.versions.length ?? 0}</span></div><small>{compareVersionIds.length}/2 已选比较</small></div>
            <div className="video-workbench__version-strip">
              <VersionLibrary
                scene={selectedScene}
                mutating={mutating === 'activate-version'}
                onActivate={activateVersion}
                selectedIds={compareVersionIds}
                onCompare={toggleCompareVersion}
              />
            </div>
          </section>
        </section>

        {settingsOpen && (
          <Inspector
            run={run}
            scene={selectedScene}
            sceneIndex={selectedSceneIndex}
            models={models}
            assets={project?.assets ?? []}
            onClose={() => setSettingsOpen(false)}
            onUpdate={saveScenePatch}
          />
        )}
      </main>

      {editMode && (
        <Timeline
          run={run}
          tracks={project?.timelineTracks ?? []}
          selectedSceneIndex={selectedSceneIndex}
          onSelect={(index) => {
            setSelectedSceneIndex(index);
            setPreviewMode('scene');
          }}
          onReorder={reorderScenes}
          disabled={run.status !== 'Editing' || Boolean(mutating)}
        />
      )}

      {batchDialogOpen && (
        <BatchRenderDialog
          pendingScenes={pendingScenes}
          defaultDuration={run.directDuration ?? 5}
          defaultModel={run.directVideoModel}
          models={models}
          submitting={mutating === 'render-batch'}
          onClose={() => setBatchDialogOpen(false)}
          onConfirm={renderBatch}
        />
      )}
    </div>
  );
};

const SceneLibraryItem: React.FC<{
  scene: VideoGenScene;
  index: number;
  active: boolean;
  onClick: () => void;
}> = ({ scene, index, active, onClick }) => {
  const status = SCENE_STATUS_REGISTRY[scene.status];
  return (
    <button className={`video-console__shot ${active ? 'is-active' : ''}`} onClick={onClick}>
      <div className="video-console__shot-thumb">
        {scene.videoUrl ? <video src={scene.videoUrl} muted preload="metadata" /> : <Film size={16} />}
        <span>{String(index + 1).padStart(2, '0')}</span>
      </div>
      <div className="video-console__shot-copy">
        <strong>{scene.topic || `镜头 ${index + 1}`}</strong>
        <span style={{ color: status.color }}>{status.label}</span>
      </div>
      <ChevronRight size={14} />
    </button>
  );
};

const EmptyLibrary = () => (
  <div className="video-console__library-empty">
    <Film size={24} />
    <strong>没有可编辑镜头</strong>
    <span>拆分镜没有返回有效结果，请返回列表重新创建。</span>
  </div>
);

const VersionLibrary: React.FC<{
  scene: VideoGenScene | null;
  mutating: boolean;
  onActivate: (version: VideoGenSceneVersion) => void;
  selectedIds: string[];
  onCompare: (version: VideoGenSceneVersion) => void;
}> = ({ scene, mutating, onActivate, selectedIds, onCompare }) => {
  const versions = scene?.versions ?? [];
  if (versions.length === 0) {
    return (
      <div className="video-console__library-empty">
        <History size={24} />
        <strong>暂无历史版本</strong>
        <span>同一镜头再次生成后，旧版本会保留在这里。</span>
      </div>
    );
  }
  return <>{[...versions].reverse().map((version, index) => (
    <div
      key={version.id}
      className={`video-console__version ${scene?.activeVersionId === version.id ? 'is-active' : ''} ${selectedIds.includes(version.id) ? 'is-compare' : ''}`}
    >
      <button className="video-console__version-select" onClick={() => onCompare(version)} disabled={mutating} title="加入版本比较">
        <video src={version.videoUrl} muted preload="metadata" />
        <div>
          <strong>版本 {versions.length - index}</strong>
          <span>{version.model || '模型池自动选择'}</span>
          <span>{new Date(version.createdAt).toLocaleString('zh-CN')}</span>
        </div>
      </button>
      <button className="video-console__version-use" onClick={() => onActivate(version)} disabled={mutating} title="采用这个版本">
        {scene?.activeVersionId === version.id ? <Check size={14} /> : <Film size={13} />}
      </button>
    </div>
  ))}</>;
};

const Inspector: React.FC<{
  run: VideoGenRun;
  scene: VideoGenScene | null;
  sceneIndex: number;
  models: VideoModelOption[];
  assets: VideoProjectAsset[];
  onClose: () => void;
  onUpdate: (patch: Parameters<typeof updateVideoSceneReal>[2]) => void;
}> = ({ run, scene, sceneIndex, models, assets, onClose, onUpdate }) => {
  const [firstFrameUrl, setFirstFrameUrl] = useState(scene?.firstFrameUrl ?? '');
  const [lastFrameUrl, setLastFrameUrl] = useState(scene?.lastFrameUrl ?? '');
  useEffect(() => { setFirstFrameUrl(scene?.firstFrameUrl ?? ''); }, [scene?.firstFrameUrl, sceneIndex]);
  useEffect(() => { setLastFrameUrl(scene?.lastFrameUrl ?? ''); }, [scene?.lastFrameUrl, sceneIndex]);

  if (!scene) {
    return <aside className="video-console__inspector"><EmptyLibrary /></aside>;
  }

  const working = scene.status === 'Rendering' || scene.status === 'Generating';
  const editable = (run.status === 'Editing' || run.status === 'Completed') && !working;
  const selectedModelId = scene.model ?? run.directVideoModel ?? '';
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const frameAssets = assets.filter((asset) => asset.type !== 'audio' && asset.url);
  return (
    <aside className="video-console__inspector" aria-label="镜头属性">
      <div className="video-console__panel-title">
        <div><SlidersHorizontal size={15} /> 镜头控制器</div>
        <div><span>SHOT {String(sceneIndex + 1).padStart(2, '0')}</span><button onClick={onClose} aria-label="关闭镜头设置"><X size={15} /></button></div>
      </div>
      <div className="video-console__inspector-scroll">
        <label className="video-console__field">
          <span>视频模型</span>
          <select
            value={selectedModelId}
            disabled={!editable}
            onChange={(event) => onUpdate({ model: event.target.value })}
          >
            <option value="">模型池自动选择</option>
            {models.map((model) => <option key={model.id} value={model.id} disabled={model.healthStatus === 'Unavailable'}>{model.name}{model.healthStatus === 'Degraded' ? '（降级）' : ''}</option>)}
          </select>
        </label>

        {selectedModel?.supportsFirstFrame && (
          <label className="video-console__field">
            <span>首帧参考</span>
            <input list={`video-first-frame-${sceneIndex}`} value={firstFrameUrl} disabled={!editable} placeholder="选择项目素材或输入公开图片 URL" onChange={(event) => setFirstFrameUrl(event.target.value)} onBlur={() => { if (firstFrameUrl.trim() !== (scene.firstFrameUrl ?? '')) onUpdate({ firstFrameUrl: firstFrameUrl.trim() }); }} />
            <datalist id={`video-first-frame-${sceneIndex}`}>{frameAssets.map((asset) => <option key={asset.id} value={asset.url}>{asset.name}</option>)}</datalist>
          </label>
        )}
        {selectedModel?.supportsLastFrame && (
          <label className="video-console__field">
            <span>尾帧参考</span>
            <input list={`video-last-frame-${sceneIndex}`} value={lastFrameUrl} disabled={!editable} placeholder="选择项目素材或输入公开图片 URL" onChange={(event) => setLastFrameUrl(event.target.value)} onBlur={() => { if (lastFrameUrl.trim() !== (scene.lastFrameUrl ?? '')) onUpdate({ lastFrameUrl: lastFrameUrl.trim() }); }} />
            <datalist id={`video-last-frame-${sceneIndex}`}>{frameAssets.map((asset) => <option key={asset.id} value={asset.url}>{asset.name}</option>)}</datalist>
          </label>
        )}
        {selectedModel?.supportsReferenceAssets && frameAssets.length > 0 && <div className="video-console__field-note">本镜会使用项目中的 {Math.min(frameAssets.length, 9)} 张角色、场景与道具参考图。</div>}

        <div className="video-console__field-grid">
          <label className="video-console__field">
            <span>时长</span>
            <select value={scene.duration ?? run.directDuration ?? 5} disabled={!editable} onChange={(event) => onUpdate({ duration: Number(event.target.value) })}>
              {(selectedModel?.durations.length ? selectedModel.durations : DURATIONS).map((duration) => <option key={duration} value={duration}>{duration} 秒</option>)}
            </select>
          </label>
          <label className="video-console__field">
            <span>分辨率</span>
            <select value={scene.resolution ?? run.directResolution ?? '720p'} disabled={!editable} onChange={(event) => onUpdate({ resolution: event.target.value })}>
              {(selectedModel?.resolutions.length ? selectedModel.resolutions : RESOLUTIONS).map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
            </select>
          </label>
        </div>

        <div className="video-console__field">
          <span>画幅</span>
          <div className="video-console__aspect-grid">
            {(selectedModel?.aspectRatios.length ? selectedModel.aspectRatios : ASPECT_RATIOS).map((ratio) => (
              <button
                key={ratio}
                className={(scene.aspectRatio ?? run.directAspectRatio ?? '16:9') === ratio ? 'is-active' : ''}
                disabled={!editable}
                onClick={() => onUpdate({ aspectRatio: ratio })}
              >
                {ratio}
              </button>
            ))}
          </div>
        </div>

        <div className="video-console__generation-info">
          <div><span>当前状态</span><strong style={{ color: SCENE_STATUS_REGISTRY[scene.status].color }}>{SCENE_STATUS_REGISTRY[scene.status].label}</strong></div>
          <div><span>生成版本</span><strong>{scene.versions?.length ?? 0}</strong></div>
          <div><span>本镜费用</span><strong>${(scene.cost ?? 0).toFixed(3)}</strong></div>
        </div>
      </div>

    </aside>
  );
};

const Timeline: React.FC<{
  run: VideoGenRun;
  tracks: VideoTimelineTrack[];
  selectedSceneIndex: number;
  onSelect: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  disabled: boolean;
}> = ({ run, tracks, selectedSceneIndex, onSelect, onReorder, disabled }) => {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const duration = Math.max(run.scenes.reduce((sum, scene) => sum + (scene.duration ?? run.directDuration ?? 5), 0), 1);
  return (
    <section className="video-console__timeline" aria-label="视频时间线">
      <div className="video-console__timeline-header">
        <div><Clock3 size={14} /> 时间线</div>
        <span>{run.scenes.length} 个镜头 · {duration} 秒</span>
      </div>
      <div className="video-console__ruler">
        {Array.from({ length: Math.ceil(duration / 5) + 1 }, (_, index) => <span key={index}>{index * 5}s</span>)}
      </div>
      <div className="video-console__track-row">
        <span className="video-console__track-label">视频</span>
        <div className="video-console__clips">
          {run.scenes.map((scene, index) => {
            const clipDuration = scene.duration ?? run.directDuration ?? 5;
            return (
              <button
                key={scene.index}
                className={`video-console__clip ${index === selectedSceneIndex ? 'is-active' : ''}`}
                style={{ flexGrow: clipDuration }}
                onClick={() => onSelect(index)}
                draggable={!disabled}
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => { if (!disabled) event.preventDefault(); }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragIndex !== null) onReorder(dragIndex, index);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
                onKeyDown={(event) => {
                  if (disabled || !event.altKey) return;
                  if (event.key === 'ArrowLeft' && index > 0) onReorder(index, index - 1);
                  if (event.key === 'ArrowRight' && index < run.scenes.length - 1) onReorder(index, index + 1);
                }}
                title="拖动排序，或按 Alt 加左右方向键移动"
              >
                <GripVertical className="video-console__clip-grip" size={12} />
                {scene.videoUrl ? <video src={scene.videoUrl} muted preload="metadata" /> : <Film size={14} />}
                <div><strong>{scene.topic || `镜头 ${index + 1}`}</strong><span>{clipDuration}s</span></div>
              </button>
            );
          })}
        </div>
      </div>
      {(['subtitle', 'voice', 'music'] as const).map((type) => {
        const track = tracks.find((item) => item.type === type);
        const label = type === 'subtitle' ? '字幕' : type === 'voice' ? '配音' : '音乐';
        return <div className="video-console__track-row" key={type}><span className="video-console__track-label">{label}</span><div className="video-console__timeline-aux">{track?.clips.map((clip, index) => <div key={clip.id}><strong>{type === 'subtitle' ? clip.text || `字幕 ${index + 1}` : clip.assetUrl?.split('/').pop() || `${label} ${index + 1}`}</strong><span>{clip.startSeconds.toFixed(1)}s · {clip.durationSeconds.toFixed(1)}s</span></div>)}{!track?.clips.length && <span>未添加{label}片段</span>}</div></div>;
      })}
    </section>
  );
};

const ViewerProgress: React.FC<{ run: VideoGenRun; label?: string }> = ({ run, label }) => (
  <div className="video-console__viewer-progress" aria-live="polite">
    <MapSpinner size={32} />
    <strong>{label || PHASE_LABELS[run.currentPhase] || '正在处理视频'}</strong>
    <ProgressBar progress={run.phaseProgress} />
    <span>任务在服务器持续执行，离开页面不会中断。</span>
  </div>
);

const ProgressBar: React.FC<{ progress: number }> = ({ progress }) => (
  <div className="video-console__progress"><i style={{ width: `${Math.max(2, Math.min(progress, 100))}%` }} /></div>
);

const BatchRenderDialog: React.FC<{
  pendingScenes: VideoGenScene[];
  defaultDuration: number;
  defaultModel?: string;
  models: VideoModelOption[];
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}> = ({ pendingScenes, defaultDuration, defaultModel, models, submitting, onClose, onConfirm }) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const submittingRef = useRef(submitting);
  useEffect(() => { submittingRef.current = submitting; }, [submitting]);
  useEffect(() => {
    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submittingRef.current) onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), input:not(:disabled)'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      returnFocusTo?.focus();
    };
  }, [onClose]);

  const duration = pendingScenes.reduce((sum, scene) => sum + (scene.duration ?? defaultDuration), 0);
  const estimatedCost = pendingScenes.reduce<number | null>((sum, scene) => {
    if (sum == null) return null;
    const option = models.find((model) => model.id === (scene.model ?? defaultModel));
    return option?.pricePerCall == null ? null : sum + option.pricePerCall;
  }, 0);
  const priceCurrency = models.find((model) => model.id === (pendingScenes[0]?.model ?? defaultModel))?.priceCurrency ?? 'CNY';
  const modal = (
    <div className="video-console__modal-backdrop" onClick={() => !submitting && onClose()}>
      <div
        ref={dialogRef}
        className="video-console__modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-render-title"
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(92vw, 480px)', maxHeight: '82vh' }}
      >
        <header>
          <div><Layers3 size={17} /><strong id="batch-render-title">批量生成镜头</strong></div>
          <button ref={closeButtonRef} onClick={onClose} disabled={submitting} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="video-console__modal-body" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <p>将按时间线顺序提交所有未完成和失败镜头，已经就绪的镜头会保留。</p>
          <dl>
            <div><dt>待生成镜头</dt><dd>{pendingScenes.length} 个</dd></div>
            <div><dt>预计视频时长</dt><dd>{duration} 秒</dd></div>
            <div><dt>预计生成费用</dt><dd>{estimatedCost == null ? '模型池未配置价格' : `${priceCurrency} ${estimatedCost.toFixed(2)}`}</dd></div>
            <div><dt>执行方式</dt><dd>服务器顺序生成</dd></div>
          </dl>
          <div className="video-console__modal-note">
            实际费用由正式模型池按最终命中的模型结算。任务提交后可离开页面，制作台会持续显示进度。
          </div>
        </div>
        <footer>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          <Button variant="primary" onClick={onConfirm} disabled={submitting}>
            {submitting ? <MapSpinner size={14} /> : <Sparkles size={14} />} 确认生成
          </Button>
        </footer>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function getPlaybackPercent(player: HTMLVideoElement | null): number {
  if (!player || !Number.isFinite(player.duration) || player.duration <= 0) return 0;
  return Math.min(100, Math.max(0, player.currentTime / player.duration * 100));
}

export default VideoStoryboardEditor;
