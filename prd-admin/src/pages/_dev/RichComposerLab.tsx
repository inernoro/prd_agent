/**
 * RichComposer 试验场
 * 用于独立测试 RichComposer 组件的各种功能和边界情况
 *
 * 访问路径: /_dev/rich-composer-lab
 */
import { useRef, useState, useCallback } from 'react';
import { RichComposer, type RichComposerRef, type ImageOption } from '@/components/RichComposer';

// 模拟画布图片数据
const MOCK_IMAGES: ImageOption[] = [
  { key: 'img-a', refId: 1, src: 'https://picsum.photos/seed/a/100/100', label: '风景图' },
  { key: 'img-b', refId: 2, src: 'https://picsum.photos/seed/b/100/100', label: '人物图' },
  { key: 'img-c', refId: 3, src: 'https://picsum.photos/seed/c/100/100', label: '产品图' },
  { key: 'img-d', refId: 4, src: 'https://picsum.photos/seed/d/100/100', label: '这是一个超级长的图片名称测试溢出情况.jpg' },
  { key: 'img-e', refId: 5, src: 'https://picsum.photos/seed/e/100/100', label: '背景素材' },
];

// 边界测试用例
const TEST_CASES = [
  { name: '正常输入', text: '请帮我修改一下图片' },
  { name: '单个 @img 引用', text: '把 @img1 的背景换成蓝色' },
  { name: '多个 @img 引用', text: '把 @img1 和 @img2 合成一张，风格参考 @img3' },
  { name: '引用不存在的图片', text: '使用 @img99 作为参考' },
  { name: '超长文本', text: '这是一段超级长的文本，用于测试输入框在内容很多的情况下是否能正常显示，包括滚动条、换行、以及与图片 chip 混合时的表现。'.repeat(3) },
  { name: '重复引用', text: '@img1 和 @img1 是同一张图' },
  { name: '空白消息', text: '   ' },
];

export default function RichComposerLab() {
  const composerRef = useRef<RichComposerRef>(null);
  const narrowComposerRef = useRef<RichComposerRef>(null);

  // 输出记录
  const [outputs, setOutputs] = useState<Array<{
    time: string;
    action: string;
    data: any;
  }>>([]);

  // 当前文本
  const [currentText, setCurrentText] = useState('');

  // 容器宽度控制
  const [containerWidth, setContainerWidth] = useState(400);

  // 添加输出记录
  const addOutput = useCallback((action: string, data: any) => {
    setOutputs(prev => [{
      time: new Date().toLocaleTimeString(),
      action,
      data,
    }, ...prev].slice(0, 20)); // 只保留最近 20 条
  }, []);

  // 获取结构化内容
  const handleGetStructuredContent = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const result = composer.getStructuredContent();
    addOutput('getStructuredContent()', result);
  }, [addOutput]);

  // 获取纯文本
  const handleGetPlainText = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const result = composer.getPlainText();
    addOutput('getPlainText()', result);
  }, [addOutput]);

  // 插入图片 chip
  const handleInsertChip = useCallback((option: ImageOption) => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.insertImageChip(option);
    addOutput('insertImageChip()', option);
  }, [addOutput]);

  // 发送
  const handleSubmit = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return true;
    const result = composer.getStructuredContent();
    addOutput('onSubmit()', result);
    composer.clear();
    return true;
  }, [addOutput]);

  // 清空
  const handleClear = useCallback(() => {
    composerRef.current?.clear();
    addOutput('clear()', null);
  }, [addOutput]);

  // 插入测试文本
  const handleInsertTestCase = useCallback((text: string) => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.clear();
    composer.insertText(text);
    addOutput('insertText()', text);
  }, [addOutput]);

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
      padding: 24,
      color: 'rgba(255,255,255,0.9)',
    }}>
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
        {/* 标题 */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
            RichComposer 试验场
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
            独立测试 RichComposer 组件的各种功能和边界情况
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* 左侧：主测试区 */}
          <div>
            {/* 模拟画布 - 可拖拽图片 */}
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 12,
              padding: 16,
              marginBottom: 16,
              border: '1px solid rgba(255,255,255,0.1)',
            }}>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
                模拟画布（点击图片插入 chip，或拖拽到输入框）
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {MOCK_IMAGES.map(img => (
                  <div
                    key={img.key}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/image-chip', JSON.stringify(img));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => handleInsertChip(img)}
                    style={{
                      cursor: 'pointer',
                      padding: 8,
                      background: 'rgba(255,255,255,0.05)',
                      borderRadius: 8,
                      border: '1px solid rgba(255,255,255,0.1)',
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(99, 102, 241, 0.2)';
                      e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                    }}
                  >
                    <img
                      src={img.src}
                      alt={img.label}
                      style={{
                        width: 60,
                        height: 60,
                        borderRadius: 6,
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                    <div style={{
                      fontSize: 10,
                      marginTop: 6,
                      color: 'rgba(255,255,255,0.7)',
                      maxWidth: 60,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textAlign: 'center',
                    }}>
                      #{img.refId} {img.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 主输入框 */}
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 12,
              padding: 16,
              marginBottom: 16,
              border: '1px solid rgba(255,255,255,0.1)',
            }}>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
                主输入框（正常宽度）
              </div>
              <div style={{
                background: 'rgba(0,0,0,0.3)',
                borderRadius: 8,
                padding: 12,
                border: '1px solid rgba(255,255,255,0.1)',
              }}>
                <RichComposer
                  ref={composerRef}
                  placeholder="输入文字，输入 @ 引用图片，或点击上方图片插入..."
                  imageOptions={MOCK_IMAGES}
                  onChange={setCurrentText}
                  onSubmit={handleSubmit}
                  minHeight={80}
                  maxHeight={200}
                />
              </div>
              <div style={{
                display: 'flex',
                gap: 8,
                marginTop: 12,
                flexWrap: 'wrap',
              }}>
                <button onClick={handleGetStructuredContent} style={btnStyle}>
                  getStructuredContent()
                </button>
                <button onClick={handleGetPlainText} style={btnStyle}>
                  getPlainText()
                </button>
                <button onClick={handleClear} style={{ ...btnStyle, background: 'rgba(239, 68, 68, 0.2)' }}>
                  clear()
                </button>
              </div>
            </div>

            {/* 窄容器测试 */}
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 12,
              padding: 16,
              marginBottom: 16,
              border: '1px solid rgba(255,255,255,0.1)',
            }}>
              <div style={{
                fontSize: 12,
                color: 'rgba(255,255,255,0.5)',
                marginBottom: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}>
                <span>窄容器测试（宽度: {containerWidth}px）</span>
                <input
                  type="range"
                  min={150}
                  max={500}
                  value={containerWidth}
                  onChange={(e) => setContainerWidth(Number(e.target.value))}
                  style={{ width: 100 }}
                />
              </div>
              <div style={{
                width: containerWidth,
                background: 'rgba(0,0,0,0.3)',
                borderRadius: 8,
                padding: 12,
                border: '1px solid rgba(255,255,255,0.1)',
                transition: 'width 0.2s',
              }}>
                <RichComposer
                  ref={narrowComposerRef}
                  placeholder="窄容器输入..."
                  imageOptions={MOCK_IMAGES}
                  minHeight={60}
                  maxHeight={120}
                />
              </div>
            </div>

            {/* 测试用例 */}
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 12,
              padding: 16,
              border: '1px solid rgba(255,255,255,0.1)',
            }}>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
                边界测试用例（点击插入到主输入框）
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {TEST_CASES.map((tc, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleInsertTestCase(tc.text)}
                    style={{
                      ...btnStyle,
                      fontSize: 11,
                      padding: '6px 10px',
                    }}
                  >
                    {tc.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 右侧：输出面板 */}
          <div>
            {/* 当前状态 */}
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 12,
              padding: 16,
              marginBottom: 16,
              border: '1px solid rgba(255,255,255,0.1)',
            }}>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
                当前文本（onChange 实时更新）
              </div>
              <div style={{
                background: 'rgba(0,0,0,0.3)',
                borderRadius: 8,
                padding: 12,
                fontSize: 12,
                fontFamily: 'monospace',
                wordBreak: 'break-all',
                minHeight: 40,
                color: 'rgba(255,255,255,0.8)',
              }}>
                {currentText || <span style={{ color: 'rgba(255,255,255,0.3)' }}>(空)</span>}
              </div>
            </div>

            {/* 输出日志 */}
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 12,
              padding: 16,
              border: '1px solid rgba(255,255,255,0.1)',
            }}>
              <div style={{
                fontSize: 12,
                color: 'rgba(255,255,255,0.5)',
                marginBottom: 12,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span>输出日志（最近 20 条）</span>
                <button
                  onClick={() => setOutputs([])}
                  style={{ ...btnStyle, fontSize: 10, padding: '4px 8px' }}
                >
                  清空
                </button>
              </div>
              <div style={{
                maxHeight: 500,
                overflowY: 'auto',
              }}>
                {outputs.length === 0 ? (
                  <div style={{
                    color: 'rgba(255,255,255,0.3)',
                    fontSize: 12,
                    textAlign: 'center',
                    padding: 20,
                  }}>
                    暂无输出，点击按钮或发送消息查看
                  </div>
                ) : (
                  outputs.map((output, idx) => (
                    <div
                      key={idx}
                      style={{
                        background: 'rgba(0,0,0,0.3)',
                        borderRadius: 8,
                        padding: 12,
                        marginBottom: 8,
                        border: '1px solid rgba(255,255,255,0.05)',
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 8,
                      }}>
                        <span style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'rgba(99, 102, 241, 1)',
                        }}>
                          {output.action}
                        </span>
                        <span style={{
                          fontSize: 10,
                          color: 'rgba(255,255,255,0.4)',
                        }}>
                          {output.time}
                        </span>
                      </div>
                      <pre style={{
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: 'rgba(255,255,255,0.8)',
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        background: 'rgba(0,0,0,0.2)',
                        padding: 8,
                        borderRadius: 4,
                      }}>
                        {JSON.stringify(output.data, null, 2)}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 验收清单 */}
        <div style={{
          marginTop: 24,
          background: 'rgba(255,255,255,0.05)',
          borderRadius: 12,
          padding: 16,
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            验收检查清单
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            fontSize: 12,
          }}>
            <CheckItem label="输入 @ 弹出下拉菜单" />
            <CheckItem label="选择图片插入 chip" />
            <CheckItem label="chip 显示序号+缩略图+标签" />
            <CheckItem label="超长标签正确截断" />
            <CheckItem label="多个 chip 不溢出" />
            <CheckItem label="窄容器布局正常" />
            <CheckItem label="getStructuredContent 返回 imageRefs" />
            <CheckItem label="Enter 发送，Shift+Enter 换行" />
            <CheckItem label="clear() 清空内容" />
          </div>
        </div>
      </div>
    </div>
  );
}

// 按钮样式
const btnStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 12,
  fontWeight: 500,
  background: 'rgba(99, 102, 241, 0.2)',
  border: '1px solid rgba(99, 102, 241, 0.3)',
  borderRadius: 6,
  color: 'rgba(255,255,255,0.9)',
  cursor: 'pointer',
  transition: 'all 0.2s',
};

// 检查项组件
function CheckItem({ label }: { label: string }) {
  const [checked, setChecked] = useState(false);
  return (
    <label style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      cursor: 'pointer',
      padding: '8px 12px',
      background: checked ? 'rgba(34, 197, 94, 0.1)' : 'rgba(0,0,0,0.2)',
      borderRadius: 6,
      border: `1px solid ${checked ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255,255,255,0.05)'}`,
      transition: 'all 0.2s',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => setChecked(e.target.checked)}
        style={{ accentColor: '#22c55e' }}
      />
      <span style={{
        color: checked ? 'rgba(34, 197, 94, 1)' : 'rgba(255,255,255,0.7)',
        textDecoration: checked ? 'line-through' : 'none',
      }}>
        {label}
      </span>
    </label>
  );
}
