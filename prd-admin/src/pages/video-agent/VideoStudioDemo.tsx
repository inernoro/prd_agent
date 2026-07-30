import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CirclePlay,
  Clapperboard,
  Film,
  Image as ImageIcon,
  Layers3,
  MessageSquareText,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import './videoConsole.css';

interface VideoStudioDemoProps {
  onBack: () => void;
}

interface DemoScene {
  id: string;
  title: string;
  beat: string;
  duration: number;
  prompt: string;
  crop: string;
  status: 'ready' | 'draft';
}

const DEMO_IMAGE = '/video-studio/story-to-film-stage.jpg';

const DEMO_SCENES: DemoScene[] = [
  {
    id: 'establishing',
    title: '雨夜街巷',
    beat: '环境建立',
    duration: 4,
    prompt: '雨后的老街延伸向远处，蓝色暮光与暖色灯笼形成冷暖对比。镜头缓慢向前推进，地面积水反射灯光。',
    crop: '22% center',
    status: 'ready',
  },
  {
    id: 'arrival',
    title: '她走进灯下',
    beat: '人物出现',
    duration: 5,
    prompt: '红色大衣的女人从画面右侧走入灯下，中景跟拍，脚步克制。雨丝在暖光中清晰可见。',
    crop: '70% center',
    status: 'ready',
  },
  {
    id: 'memory',
    title: '旧店的灯',
    beat: '情绪转折',
    duration: 4,
    prompt: '女人停在旧店门前，抬头看向晃动的灯笼。镜头由中景缓慢推到侧脸特写，环境声逐渐降低。',
    crop: '88% center',
    status: 'ready',
  },
  {
    id: 'ending',
    title: '走向街巷深处',
    beat: '余韵收束',
    duration: 5,
    prompt: '人物背影沿湿润街道继续向前，镜头停留原地，景深逐渐变浅，远处车灯化成柔和光斑。',
    crop: '48% center',
    status: 'draft',
  },
];

export const VideoStudioDemo: React.FC<VideoStudioDemoProps> = ({ onBack }) => {
  const [selectedSceneId, setSelectedSceneId] = useState(DEMO_SCENES[1].id);
  const [prompt, setPrompt] = useState(DEMO_SCENES[1].prompt);
  const [isPlaying, setIsPlaying] = useState(false);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [saved, setSaved] = useState(false);
  const [generatedSceneIds, setGeneratedSceneIds] = useState(
    () => DEMO_SCENES.filter((scene) => scene.status === 'ready').map((scene) => scene.id),
  );

  const selectedScene = useMemo(
    () => DEMO_SCENES.find((scene) => scene.id === selectedSceneId) ?? DEMO_SCENES[0],
    [selectedSceneId],
  );
  const totalDuration = DEMO_SCENES.reduce((sum, scene) => sum + scene.duration, 0);
  const selectedSceneReady = generatedSceneIds.includes(selectedScene.id);
  const workflowStages = [
    { label: '创意简报', detail: '已确认', state: 'done' },
    { label: '故事分镜', detail: `${DEMO_SCENES.length} 个镜头`, state: 'active' },
    { label: '生成素材', detail: `${generatedSceneIds.length} / ${DEMO_SCENES.length} 就绪`, state: 'pending' },
    { label: '合成成片', detail: generatedSceneIds.length === DEMO_SCENES.length ? '可以开始' : '待开始', state: 'pending' },
  ] as const;

  const selectScene = (scene: DemoScene) => {
    setSelectedSceneId(scene.id);
    setPrompt(scene.prompt);
    setSaved(false);
  };

  return (
    <div className="video-demo" data-testid="video-studio-demo">
      <header className="video-demo__header">
        <div className="video-demo__identity">
          <button onClick={onBack} aria-label="返回视频创作首页"><ArrowLeft size={18} /></button>
          <span className="video-demo__mark"><Clapperboard size={18} /></span>
          <div>
            <strong>雨夜来信</strong>
            <span>体验样片 · 自动保存</span>
          </div>
        </div>
        <ol className="video-demo__stages" aria-label="视频创作流程">
          {workflowStages.map((stage, index) => (
            <li key={stage.label} className={`is-${stage.state}`}>
              <i>{stage.state === 'done' ? <Check size={12} /> : index + 1}</i>
              <span><strong>{stage.label}</strong><small>{stage.detail}</small></span>
            </li>
          ))}
        </ol>
        <div className="video-demo__header-actions">
          <span><i /> 演示数据</span>
          <Button size="sm" variant="primary" onClick={onBack}>用我的内容创作</Button>
        </div>
      </header>

      <main className="video-demo__workspace">
        <aside className="video-demo__scenes" aria-label="分镜列表">
          <div className="video-demo__section-title">
            <div><Layers3 size={16} /><strong>故事分镜</strong></div>
            <span>{DEMO_SCENES.length} 个镜头 · {totalDuration} 秒</span>
          </div>
          <div className="video-demo__scene-list">
            {DEMO_SCENES.map((scene, index) => (
              <button
                key={scene.id}
                className={scene.id === selectedScene.id ? 'is-active' : ''}
                onClick={() => selectScene(scene)}
              >
                <span className="video-demo__scene-thumb">
                  <img src={DEMO_IMAGE} alt="" style={{ objectPosition: scene.crop }} />
                  <i>{String(index + 1).padStart(2, '0')}</i>
                </span>
                <span className="video-demo__scene-copy">
                  <strong>{scene.title}</strong>
                  <small>{scene.beat} · {scene.duration} 秒</small>
                  <em className={generatedSceneIds.includes(scene.id) ? 'is-ready' : 'is-draft'}>{generatedSceneIds.includes(scene.id) ? '画面已就绪' : '等待生成'}</em>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          <button className="video-demo__add-scene"><Sparkles size={15} /> 根据上下文补一个镜头</button>
        </aside>

        <section className="video-demo__canvas" aria-label="镜头预览">
          <div className="video-demo__canvas-toolbar">
            <div>
              <span className="video-demo__eyebrow">镜头 {DEMO_SCENES.indexOf(selectedScene) + 1}</span>
              <strong>{selectedScene.title}</strong>
            </div>
            <div className="video-demo__view-toggle" role="group" aria-label="预览画幅">
              {['16:9', '9:16', '1:1'].map((ratio) => (
                <button key={ratio} className={aspectRatio === ratio ? 'is-active' : ''} onClick={() => setAspectRatio(ratio)}>{ratio}</button>
              ))}
            </div>
          </div>

          <div className={`video-demo__viewer is-${aspectRatio.replace(':', '-')}${isPlaying ? ' is-playing' : ''}`}>
            <img src={DEMO_IMAGE} alt={`${selectedScene.title}的画面预览`} style={{ objectPosition: selectedScene.crop }} />
            <div className="video-demo__viewer-shade" />
            <div className="video-demo__viewer-caption">
              <span>{selectedScene.beat}</span>
              <strong>{selectedScene.title}</strong>
              <small>电影叙事 · 柔和推进 · 环境同期声</small>
            </div>
            <button className="video-demo__play" onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? '暂停样片' : '播放样片'}>
              {isPlaying ? <Pause size={23} /> : <Play size={23} fill="currentColor" />}
            </button>
          </div>

          <div className="video-demo__transport">
            <button onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? '暂停' : '播放'}>{isPlaying ? <Pause size={16} /> : <Play size={16} />}</button>
            <span>00:05</span>
            <div><i style={{ width: isPlaying ? '64%' : '28%' }} /></div>
            <span>00:{String(totalDuration).padStart(2, '0')}</span>
            <button aria-label="预览声音"><Volume2 size={16} /></button>
          </div>

          <div className="video-demo__timeline" aria-label="样片时间线">
            <div className="video-demo__timeline-label"><Film size={15} /><span>画面</span></div>
            <div className="video-demo__timeline-track">
              {DEMO_SCENES.map((scene) => (
                <button key={scene.id} className={scene.id === selectedScene.id ? 'is-active' : ''} onClick={() => selectScene(scene)} style={{ flex: scene.duration }}>
                  <img src={DEMO_IMAGE} alt="" style={{ objectPosition: scene.crop }} />
                  <span>{scene.title}</span>
                </button>
              ))}
            </div>
            <div className="video-demo__timeline-label"><MessageSquareText size={15} /><span>字幕</span></div>
            <div className="video-demo__audio-track"><span>雨停之后，她终于回到那条熟悉的街。</span></div>
            <div className="video-demo__timeline-label"><Music2 size={15} /><span>音乐</span></div>
            <div className="video-demo__music-track"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          </div>
        </section>

        <aside className="video-demo__inspector" aria-label="镜头编辑">
          <div className="video-demo__section-title">
            <div><SlidersHorizontal size={16} /><strong>镜头编辑</strong></div>
            <span>所见即所得</span>
          </div>
          <div className="video-demo__inspector-scroll">
            <label className="video-demo__field">
              <span>画面描述</span>
              <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); setSaved(false); }} />
              <small>{prompt.length} 字 · 会影响人物动作、运镜和环境</small>
            </label>
            <div className="video-demo__quick-actions">
              <button onClick={() => setPrompt(`${prompt.replace(/[。.]$/, '')}，镜头节奏更舒缓，保留自然环境声。`)}><RefreshCw size={14} /> AI 润色</button>
              <button onClick={() => setSaved(true)}><Save size={14} /> {saved ? '已保存' : '保存描述'}</button>
            </div>

            <div className="video-demo__field">
              <span>首帧参考</span>
              <button className="video-demo__reference-card">
                <img src={DEMO_IMAGE} alt="雨夜街巷首帧参考" />
                <span><strong>雨夜街巷</strong><small>保持人物与场景一致</small></span>
                <ImageIcon size={16} />
              </button>
            </div>

            <div className="video-demo__setting-grid">
              <label><span>运镜</span><select defaultValue="slow"><option value="slow">缓慢推进</option><option value="follow">平稳跟拍</option><option value="static">固定机位</option></select></label>
              <label><span>时长</span><select defaultValue={selectedScene.duration}><option value={4}>4 秒</option><option value={5}>5 秒</option><option value={8}>8 秒</option></select></label>
              <label><span>画质</span><select defaultValue="1080p"><option>1080p</option><option>720p</option></select></label>
              <label><span>声音</span><select defaultValue="ambient"><option value="ambient">环境同期声</option><option value="silent">静音</option></select></label>
            </div>

            <div className="video-demo__generation-card">
              <span><CirclePlay size={16} /> 生成设置</span>
              <dl>
                <div><dt>模型</dt><dd>模型池自动选择</dd></div>
                <div><dt>预计耗时</dt><dd>约 2–4 分钟</dd></div>
                <div><dt>失败处理</dt><dd>自动保留当前版本</dd></div>
              </dl>
              <Button
                variant="primary"
                className="w-full"
                onClick={() => setGeneratedSceneIds((current) => current.includes(selectedScene.id) ? current : [...current, selectedScene.id])}
              >
                <Sparkles size={16} /> {selectedSceneReady ? '生成新版本' : '生成这个镜头'}
              </Button>
              <small>这是交互 Demo，不会产生实际费用。</small>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
};

export default VideoStudioDemo;
