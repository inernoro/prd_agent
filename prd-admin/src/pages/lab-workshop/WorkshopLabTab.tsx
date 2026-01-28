/**
 * 试验车间 - RichComposer 组件测试
 * 用于独立测试 RichComposer 组件的各种功能和边界情况
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
  { name: '单个 @img', text: '把 @img1 的背景换成蓝色' },
  { name: '多个 @img', text: '把 @img1 和 @img2 合成，风格参考 @img3' },
  { name: '@img99', text: '使用 @img99 作为参考' },
  { name: '超长文本', text: '这是一段超级长的文本用于测试输入框在内容很多的情况下是否能正常显示包括滚动条换行以及与图片chip混合时的表现。'.repeat(2) },
  { name: '重复引用', text: '@img1 和 @img1 是同一张' },
  { name: '空白', text: '   ' },
];

export default function WorkshopLabTab() {
  const composerRef = useRef<RichComposerRef>(null);
  const narrowComposerRef = useRef<RichComposerRef>(null);

  const [outputs, setOutputs] = useState<Array<{
    time: string;
    action: string;
    data: any;
  }>>([]);

  const [currentText, setCurrentText] = useState('');
  const [containerWidth, setContainerWidth] = useState(300);

  const addOutput = useCallback((action: string, data: any) => {
    setOutputs(prev => [{
      time: new Date().toLocaleTimeString(),
      action,
      data,
    }, ...prev].slice(0, 15));
  }, []);

  const handleGetStructuredContent = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const result = composer.getStructuredContent();
    addOutput('getStructuredContent()', result);
  }, [addOutput]);

  const handleGetPlainText = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const result = composer.getPlainText();
    addOutput('getPlainText()', result);
  }, [addOutput]);

  const handleInsertChip = useCallback((option: ImageOption) => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.insertImageChip(option);
    addOutput('insertImageChip()', option);
  }, [addOutput]);

  const handleSubmit = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return true;
    const result = composer.getStructuredContent();
    addOutput('onSubmit()', result);
    composer.clear();
    return true;
  }, [addOutput]);

  const handleClear = useCallback(() => {
    composerRef.current?.clear();
    addOutput('clear()', null);
  }, [addOutput]);

  /**
   * 插入测试用例文本，解析 @imgN 并转换为实际的 chip
   */
  const handleInsertTestCase = useCallback((text: string) => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.clear();
    composer.focus();

    // 解析 @imgN 模式，拆分为文本和引用段
    const pattern = /@img(\d+)/g;
    let lastIndex = 0;
    let match;
    const segments: Array<{ type: 'text' | 'ref'; value: string; refId?: number }> = [];

    while ((match = pattern.exec(text)) !== null) {
      // 添加 @img 之前的文本
      if (match.index > lastIndex) {
        segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      // 添加引用
      segments.push({ type: 'ref', value: match[0], refId: parseInt(match[1], 10) });
      lastIndex = pattern.lastIndex;
    }
    // 添加剩余文本
    if (lastIndex < text.length) {
      segments.push({ type: 'text', value: text.slice(lastIndex) });
    }

    // 逐段插入
    for (const seg of segments) {
      if (seg.type === 'text') {
        composer.insertText(seg.value);
      } else {
        // 查找对应的图片
        const img = MOCK_IMAGES.find((i) => i.refId === seg.refId);
        if (img) {
          composer.insertImageChip(img);
        } else {
          // 找不到对应图片，插入原文
          composer.insertText(seg.value);
        }
      }
    }

    addOutput('insertTestCase()', { text, segments });
  }, [addOutput]);

  return (
    <div className="h-full overflow-auto" style={{ padding: 16 }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        {/* 标题 */}
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            RichComposer 试验场
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            测试富文本输入组件的各种功能和边界情况
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* 左侧：测试区 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 模拟画布 */}
            <div style={{
              background: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: 12,
              border: '1px solid var(--border-default)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                模拟画布（点击插入 chip）
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {MOCK_IMAGES.map(img => (
                  <div
                    key={img.key}
                    onClick={() => handleInsertChip(img)}
                    style={{
                      cursor: 'pointer',
                      padding: 6,
                      background: 'var(--bg-base)',
                      borderRadius: 6,
                      border: '1px solid var(--border-default)',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.5)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--border-default)';
                    }}
                  >
                    <img
                      src={img.src}
                      alt={img.label}
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 4,
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                    <div style={{
                      fontSize: 9,
                      marginTop: 4,
                      color: 'var(--text-muted)',
                      maxWidth: 48,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textAlign: 'center',
                    }}>
                      #{img.refId}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 主输入框 */}
            <div style={{
              background: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: 12,
              border: '1px solid var(--border-default)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                主输入框
              </div>
              <div style={{
                background: 'var(--bg-base)',
                borderRadius: 6,
                padding: 10,
                border: '1px solid var(--border-default)',
              }}>
                <RichComposer
                  ref={composerRef}
                  placeholder="输入文字，输入 @ 引用图片..."
                  imageOptions={MOCK_IMAGES}
                  onChange={setCurrentText}
                  onSubmit={handleSubmit}
                  minHeight={60}
                  maxHeight={150}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <Btn onClick={handleGetStructuredContent}>getStructuredContent()</Btn>
                <Btn onClick={handleGetPlainText}>getPlainText()</Btn>
                <Btn onClick={handleClear} variant="danger">clear()</Btn>
              </div>
            </div>

            {/* 窄容器测试 */}
            <div style={{
              background: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: 12,
              border: '1px solid var(--border-default)',
            }}>
              <div style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <span>窄容器测试</span>
                <input
                  type="range"
                  min={120}
                  max={400}
                  value={containerWidth}
                  onChange={(e) => setContainerWidth(Number(e.target.value))}
                  style={{ width: 80 }}
                />
                <span style={{ fontSize: 10 }}>{containerWidth}px</span>
              </div>
              <div style={{
                width: containerWidth,
                background: 'var(--bg-base)',
                borderRadius: 6,
                padding: 10,
                border: '1px solid var(--border-default)',
                transition: 'width 0.15s',
              }}>
                <RichComposer
                  ref={narrowComposerRef}
                  placeholder="窄容器..."
                  imageOptions={MOCK_IMAGES}
                  minHeight={40}
                  maxHeight={80}
                />
              </div>
            </div>

            {/* 测试用例 */}
            <div style={{
              background: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: 12,
              border: '1px solid var(--border-default)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                边界测试用例
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {TEST_CASES.map((tc, idx) => (
                  <Btn key={idx} onClick={() => handleInsertTestCase(tc.text)} size="sm">
                    {tc.name}
                  </Btn>
                ))}
              </div>
            </div>
          </div>

          {/* 右侧：输出面板 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 当前文本 */}
            <div style={{
              background: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: 12,
              border: '1px solid var(--border-default)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                当前文本（实时）
              </div>
              <div style={{
                background: 'var(--bg-base)',
                borderRadius: 6,
                padding: 10,
                fontSize: 11,
                fontFamily: 'monospace',
                wordBreak: 'break-all',
                minHeight: 32,
                color: 'var(--text-primary)',
              }}>
                {currentText || <span style={{ color: 'var(--text-muted)' }}>(空)</span>}
              </div>
            </div>

            {/* 输出日志 */}
            <div style={{
              background: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: 12,
              border: '1px solid var(--border-default)',
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}>
              <div style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginBottom: 8,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span>输出日志</span>
                <Btn onClick={() => setOutputs([])} size="xs">清空</Btn>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {outputs.length === 0 ? (
                  <div style={{
                    color: 'var(--text-muted)',
                    fontSize: 11,
                    textAlign: 'center',
                    padding: 16,
                  }}>
                    点击按钮或发送消息查看输出
                  </div>
                ) : (
                  outputs.map((output, idx) => (
                    <div
                      key={idx}
                      style={{
                        background: 'var(--bg-base)',
                        borderRadius: 6,
                        padding: 10,
                        marginBottom: 6,
                        border: '1px solid var(--border-default)',
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 6,
                      }}>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: 'rgba(99, 102, 241, 1)',
                        }}>
                          {output.action}
                        </span>
                        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                          {output.time}
                        </span>
                      </div>
                      <pre style={{
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: 'var(--text-primary)',
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        background: 'rgba(0,0,0,0.2)',
                        padding: 6,
                        borderRadius: 4,
                        maxHeight: 120,
                        overflow: 'auto',
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
          marginTop: 16,
          background: 'var(--bg-elevated)',
          borderRadius: 8,
          padding: 12,
          border: '1px solid var(--border-default)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            验收检查清单
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
            <CheckItem label="@ 弹出下拉" />
            <CheckItem label="选择插入 chip" />
            <CheckItem label="chip 显示正确" />
            <CheckItem label="超长标签截断" />
            <CheckItem label="窄容器正常" />
            <CheckItem label="imageRefs 返回" />
            <CheckItem label="Enter 发送" />
            <CheckItem label="Shift+Enter 换行" />
          </div>
        </div>
      </div>
    </div>
  );
}

// 按钮组件
function Btn({
  children,
  onClick,
  variant = 'default',
  size = 'md',
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger';
  size?: 'xs' | 'sm' | 'md';
}) {
  const sizeStyles = {
    xs: { padding: '2px 6px', fontSize: 9 },
    sm: { padding: '4px 8px', fontSize: 10 },
    md: { padding: '6px 10px', fontSize: 11 },
  };
  const variantStyles = {
    default: { background: 'rgba(99, 102, 241, 0.15)', borderColor: 'rgba(99, 102, 241, 0.25)' },
    danger: { background: 'rgba(239, 68, 68, 0.15)', borderColor: 'rgba(239, 68, 68, 0.25)' },
  };
  return (
    <button
      onClick={onClick}
      style={{
        ...sizeStyles[size],
        ...variantStyles[variant],
        fontWeight: 500,
        border: '1px solid',
        borderRadius: 4,
        color: 'var(--text-primary)',
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  );
}

// 检查项组件
function CheckItem({ label }: { label: string }) {
  const [checked, setChecked] = useState(false);
  return (
    <label style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      cursor: 'pointer',
      padding: '4px 8px',
      background: checked ? 'rgba(34, 197, 94, 0.1)' : 'var(--bg-base)',
      borderRadius: 4,
      border: `1px solid ${checked ? 'rgba(34, 197, 94, 0.3)' : 'var(--border-default)'}`,
      transition: 'all 0.15s',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => setChecked(e.target.checked)}
        style={{ accentColor: '#22c55e', width: 12, height: 12 }}
      />
      <span style={{
        color: checked ? 'rgba(34, 197, 94, 1)' : 'var(--text-secondary)',
        textDecoration: checked ? 'line-through' : 'none',
      }}>
        {label}
      </span>
    </label>
  );
}
