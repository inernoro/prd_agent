/**
 * 模板工作流组件
 * 完整的视频创建流程：选模板 → AI 填参数 → 编辑 → 预览
 */
import { useState, useCallback, useMemo } from 'react';
import { Player } from '@remotion/player';
import { TemplateDefinition, AspectRatio, ASPECT_RATIO_CONFIG } from '../types';
import { TemplateSelector } from './TemplateSelector';
import { TemplateParamsForm } from './TemplateParamsForm';
import { useAIGenerator } from '../hooks/useAIGenerator';

type WorkflowStep = 'select' | 'input' | 'edit' | 'preview';

interface TemplateWorkflowProps {
  onExport?: (params: { template: TemplateDefinition; props: Record<string, unknown> }) => void;
}

export function TemplateWorkflow({ onExport }: TemplateWorkflowProps) {
  // 工作流状态
  const [currentStep, setCurrentStep] = useState<WorkflowStep>('select');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateDefinition | null>(null);
  const [userInput, setUserInput] = useState('');
  const [videoParams, setVideoParams] = useState<Record<string, unknown>>({});
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [duration, setDuration] = useState(10);

  // AI 生成器
  const aiGenerator = useAIGenerator(selectedTemplate);

  // 视频配置
  const videoConfig = useMemo(() => {
    const config = ASPECT_RATIO_CONFIG[aspectRatio];
    return {
      width: config.width,
      height: config.height,
      fps: 30,
      durationInFrames: duration * 30,
    };
  }, [aspectRatio, duration]);

  // 处理模板选择
  const handleSelectTemplate = useCallback((template: TemplateDefinition) => {
    setSelectedTemplate(template);
    setVideoParams(template.defaultProps);
    setDuration(template.defaultDuration);
    setCurrentStep('input');
  }, []);

  // 处理 AI 生成
  const handleAIGenerate = useCallback(async () => {
    if (!userInput.trim()) return;

    const result = await aiGenerator.generate(userInput);
    if (result) {
      setVideoParams(result.props as Record<string, unknown>);
      setCurrentStep('edit');
    }
  }, [userInput, aiGenerator]);

  // 跳过 AI 直接编辑
  const handleSkipAI = useCallback(() => {
    if (selectedTemplate) {
      setVideoParams(selectedTemplate.defaultProps);
      setCurrentStep('edit');
    }
  }, [selectedTemplate]);

  // 进入预览
  const handlePreview = useCallback(() => {
    setCurrentStep('preview');
  }, []);

  // 返回上一步
  const handleBack = useCallback(() => {
    switch (currentStep) {
      case 'input':
        setCurrentStep('select');
        break;
      case 'edit':
        setCurrentStep('input');
        break;
      case 'preview':
        setCurrentStep('edit');
        break;
    }
  }, [currentStep]);

  // 导出视频
  const handleExport = useCallback(() => {
    if (selectedTemplate && onExport) {
      onExport({ template: selectedTemplate, props: videoParams });
    }
  }, [selectedTemplate, videoParams, onExport]);

  // 步骤指示器
  const steps: Array<{ key: WorkflowStep; label: string; icon: string }> = [
    { key: 'select', label: '选择模板', icon: '📋' },
    { key: 'input', label: 'AI 生成', icon: '✨' },
    { key: 'edit', label: '编辑参数', icon: '✏️' },
    { key: 'preview', label: '预览导出', icon: '🎬' },
  ];

  const currentStepIndex = steps.findIndex((s) => s.key === currentStep);

  return (
    <div className="template-workflow">
      {/* 步骤指示器 */}
      <div className="workflow-steps">
        {steps.map((step, index) => (
          <div
            key={step.key}
            className={`workflow-step ${index <= currentStepIndex ? 'active' : ''} ${
              step.key === currentStep ? 'current' : ''
            }`}
          >
            <div className="step-icon">{step.icon}</div>
            <div className="step-label">{step.label}</div>
            {index < steps.length - 1 && <div className="step-connector" />}
          </div>
        ))}
      </div>

      {/* 步骤内容 */}
      <div className="workflow-content">
        {/* 步骤 1: 选择模板 */}
        {currentStep === 'select' && (
          <div className="step-content">
            <h2 className="step-title">选择视频模板</h2>
            <p className="step-description">选择一个适合您需求的模板作为起点</p>
            <TemplateSelector
              selectedTemplate={selectedTemplate}
              onSelect={handleSelectTemplate}
            />
          </div>
        )}

        {/* 步骤 2: AI 输入 */}
        {currentStep === 'input' && selectedTemplate && (
          <div className="step-content">
            <h2 className="step-title">描述您的视频</h2>
            <p className="step-description">
              用一句话描述您想要的视频内容，AI 将自动填充参数
            </p>

            <div className="ai-input-section">
              <div className="example-hint">
                <span className="hint-icon">💡</span>
                <span>例如：{selectedTemplate.exampleUserInput}</span>
              </div>

              <textarea
                className="ai-input"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                placeholder="描述您想要的视频内容..."
                rows={4}
              />

              <div className="ai-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleAIGenerate}
                  disabled={!userInput.trim() || aiGenerator.isGenerating}
                >
                  {aiGenerator.isGenerating ? (
                    <>
                      <span className="spinner" />
                      {aiGenerator.progress || '生成中...'}
                    </>
                  ) : (
                    <>
                      <span>✨</span> AI 智能填充
                    </>
                  )}
                </button>

                <button className="btn btn-secondary" onClick={handleSkipAI}>
                  跳过，手动填写
                </button>
              </div>

              {aiGenerator.error && (
                <div className="ai-error">
                  <span>⚠️</span> {aiGenerator.error}
                </div>
              )}

              {aiGenerator.result && (
                <div className="ai-result">
                  <div className="confidence">
                    信心度: {Math.round(aiGenerator.result.confidence * 100)}%
                  </div>
                  {aiGenerator.result.suggestions &&
                    aiGenerator.result.suggestions.length > 0 && (
                      <div className="suggestions">
                        {aiGenerator.result.suggestions.map((s, i) => (
                          <div key={i} className="suggestion">
                            💡 {s}
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              )}
            </div>

            <button className="btn btn-back" onClick={handleBack}>
              ← 返回选择模板
            </button>
          </div>
        )}

        {/* 步骤 3: 编辑参数 */}
        {currentStep === 'edit' && selectedTemplate && (
          <div className="step-content step-content-split">
            <div className="edit-panel">
              <h2 className="step-title">编辑视频参数</h2>
              <p className="step-description">调整各项参数以完善您的视频</p>

              {/* 视频设置 */}
              <div className="video-settings">
                <div className="setting-item">
                  <label>画面比例</label>
                  <div className="aspect-ratio-options">
                    {selectedTemplate.supportedAspectRatios.map((ratio) => (
                      <button
                        key={ratio}
                        className={`ratio-btn ${aspectRatio === ratio ? 'active' : ''}`}
                        onClick={() => setAspectRatio(ratio)}
                      >
                        {ASPECT_RATIO_CONFIG[ratio].label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="setting-item">
                  <label>视频时长</label>
                  <div className="duration-input">
                    <input
                      type="number"
                      value={duration}
                      onChange={(e) => setDuration(parseInt(e.target.value) || 10)}
                      min={5}
                      max={60}
                    />
                    <span>秒</span>
                  </div>
                </div>
              </div>

              {/* 参数表单 */}
              <div className="params-form-container">
                <TemplateParamsForm
                  template={selectedTemplate}
                  values={videoParams}
                  onChange={setVideoParams}
                />
              </div>

              <div className="edit-actions">
                <button className="btn btn-back" onClick={handleBack}>
                  ← 返回
                </button>
                <button className="btn btn-primary" onClick={handlePreview}>
                  预览视频 →
                </button>
              </div>
            </div>

            {/* 实时预览 */}
            <div className="preview-panel">
              <div className="preview-header">
                <span>实时预览</span>
              </div>
              <div className="preview-container">
                <Player
                  component={selectedTemplate.component}
                  inputProps={videoParams}
                  durationInFrames={videoConfig.durationInFrames}
                  fps={videoConfig.fps}
                  compositionWidth={videoConfig.width}
                  compositionHeight={videoConfig.height}
                  style={{
                    width: '100%',
                    aspectRatio: `${videoConfig.width}/${videoConfig.height}`,
                  }}
                  controls
                  loop
                />
              </div>
            </div>
          </div>
        )}

        {/* 步骤 4: 预览导出 */}
        {currentStep === 'preview' && selectedTemplate && (
          <div className="step-content">
            <h2 className="step-title">预览与导出</h2>
            <p className="step-description">确认视频效果，然后导出</p>

            <div className="final-preview">
              <Player
                component={selectedTemplate.component}
                inputProps={videoParams}
                durationInFrames={videoConfig.durationInFrames}
                fps={videoConfig.fps}
                compositionWidth={videoConfig.width}
                compositionHeight={videoConfig.height}
                style={{
                  width: '100%',
                  maxWidth: 800,
                  aspectRatio: `${videoConfig.width}/${videoConfig.height}`,
                }}
                controls
                loop
              />
            </div>

            <div className="export-info">
              <div className="info-item">
                <span className="info-label">模板</span>
                <span className="info-value">{selectedTemplate.name}</span>
              </div>
              <div className="info-item">
                <span className="info-label">分辨率</span>
                <span className="info-value">
                  {videoConfig.width} x {videoConfig.height}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">时长</span>
                <span className="info-value">{duration} 秒</span>
              </div>
              <div className="info-item">
                <span className="info-label">帧率</span>
                <span className="info-value">{videoConfig.fps} FPS</span>
              </div>
            </div>

            <div className="export-actions">
              <button className="btn btn-back" onClick={handleBack}>
                ← 返回编辑
              </button>
              <button className="btn btn-primary" onClick={handleExport}>
                🎬 导出视频
              </button>
            </div>

            <div className="export-note">
              <span>💡</span>
              <span>
                导出功能需要后端渲染服务支持。目前版本仅支持前端预览，完整导出功能将在后续版本中推出。
              </span>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .template-workflow {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: #0f172a;
        }

        .workflow-steps {
          display: flex;
          justify-content: center;
          padding: 24px;
          background: rgba(0, 0, 0, 0.3);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .workflow-step {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          border-radius: 20px;
          transition: all 0.3s;
          position: relative;
        }

        .workflow-step.active {
          color: #e2e8f0;
        }

        .workflow-step:not(.active) {
          color: #475569;
        }

        .workflow-step.current {
          background: rgba(99, 102, 241, 0.2);
          color: #818cf8;
        }

        .step-icon {
          font-size: 18px;
        }

        .step-label {
          font-size: 13px;
          font-weight: 500;
        }

        .step-connector {
          width: 40px;
          height: 2px;
          background: rgba(255, 255, 255, 0.1);
          margin-left: 16px;
        }

        .workflow-step.active .step-connector {
          background: rgba(99, 102, 241, 0.5);
        }

        .workflow-content {
          flex: 1;
          overflow-y: auto;
          padding: 32px;
        }

        .step-content {
          max-width: 900px;
          margin: 0 auto;
        }

        .step-content-split {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 32px;
          max-width: 1400px;
        }

        .step-title {
          font-size: 24px;
          font-weight: 600;
          color: #e2e8f0;
          margin: 0 0 8px;
        }

        .step-description {
          font-size: 14px;
          color: #64748b;
          margin: 0 0 24px;
        }

        .ai-input-section {
          display: flex;
          flex-direction: column;
          gap: 16px;
          margin-bottom: 24px;
        }

        .example-hint {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 12px 16px;
          background: rgba(99, 102, 241, 0.1);
          border-radius: 8px;
          font-size: 13px;
          color: #94a3b8;
          line-height: 1.5;
        }

        .hint-icon {
          flex-shrink: 0;
        }

        .ai-input {
          width: 100%;
          padding: 16px;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 12px;
          font-size: 15px;
          color: #fff;
          resize: vertical;
          min-height: 120px;
          box-sizing: border-box;
        }

        .ai-input:focus {
          outline: none;
          border-color: #6366f1;
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
        }

        .ai-input::placeholder {
          color: #475569;
        }

        .ai-actions {
          display: flex;
          gap: 12px;
        }

        .ai-error {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          background: rgba(239, 68, 68, 0.1);
          border-radius: 8px;
          font-size: 13px;
          color: #f87171;
        }

        .ai-result {
          padding: 16px;
          background: rgba(34, 197, 94, 0.1);
          border-radius: 8px;
        }

        .confidence {
          font-size: 13px;
          color: #4ade80;
          margin-bottom: 8px;
        }

        .suggestions {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .suggestion {
          font-size: 12px;
          color: #94a3b8;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 24px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          border: none;
        }

        .btn-primary {
          background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
          color: #fff;
        }

        .btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
        }

        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }

        .btn-secondary {
          background: rgba(255, 255, 255, 0.1);
          color: #94a3b8;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .btn-secondary:hover {
          background: rgba(255, 255, 255, 0.15);
          color: #e2e8f0;
        }

        .btn-back {
          background: transparent;
          color: #64748b;
          padding: 12px 16px;
        }

        .btn-back:hover {
          color: #94a3b8;
        }

        .spinner {
          width: 16px;
          height: 16px;
          border: 2px solid rgba(255, 255, 255, 0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .edit-panel {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .video-settings {
          display: flex;
          gap: 24px;
          padding: 16px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 12px;
        }

        .setting-item {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .setting-item label {
          font-size: 12px;
          font-weight: 500;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .aspect-ratio-options {
          display: flex;
          gap: 8px;
        }

        .ratio-btn {
          padding: 8px 12px;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          font-size: 12px;
          color: #94a3b8;
          cursor: pointer;
          transition: all 0.2s;
        }

        .ratio-btn:hover {
          border-color: rgba(255, 255, 255, 0.2);
          color: #e2e8f0;
        }

        .ratio-btn.active {
          background: rgba(99, 102, 241, 0.2);
          border-color: rgba(99, 102, 241, 0.5);
          color: #818cf8;
        }

        .duration-input {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .duration-input input {
          width: 60px;
          padding: 8px 12px;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          font-size: 14px;
          color: #fff;
          text-align: center;
        }

        .duration-input input:focus {
          outline: none;
          border-color: #6366f1;
        }

        .duration-input span {
          font-size: 13px;
          color: #64748b;
        }

        .params-form-container {
          flex: 1;
          overflow-y: auto;
          max-height: 400px;
          padding-right: 8px;
        }

        .edit-actions {
          display: flex;
          justify-content: space-between;
          padding-top: 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
        }

        .preview-panel {
          display: flex;
          flex-direction: column;
          background: rgba(0, 0, 0, 0.3);
          border-radius: 12px;
          overflow: hidden;
        }

        .preview-header {
          padding: 12px 16px;
          background: rgba(0, 0, 0, 0.3);
          font-size: 13px;
          font-weight: 500;
          color: #94a3b8;
        }

        .preview-container {
          flex: 1;
          padding: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .final-preview {
          display: flex;
          justify-content: center;
          margin-bottom: 32px;
        }

        .export-info {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
          padding: 20px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 12px;
          margin-bottom: 24px;
        }

        .info-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .info-label {
          font-size: 12px;
          color: #64748b;
        }

        .info-value {
          font-size: 15px;
          font-weight: 500;
          color: #e2e8f0;
        }

        .export-actions {
          display: flex;
          justify-content: center;
          gap: 16px;
          margin-bottom: 24px;
        }

        .export-note {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 16px;
          background: rgba(251, 191, 36, 0.1);
          border-radius: 8px;
          font-size: 13px;
          color: #fbbf24;
          line-height: 1.5;
        }
      `}</style>
    </div>
  );
}

export default TemplateWorkflow;
