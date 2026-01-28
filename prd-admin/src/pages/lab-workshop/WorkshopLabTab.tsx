/**
 * 试验车间 - RichComposer 组件测试
 * 用于独立测试 RichComposer 组件的各种功能和边界情况
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import { RichComposer, type RichComposerRef, type ImageOption } from '@/components/RichComposer';

// 自动测试结果类型
type TestResult = {
  name: string;
  status: 'pending' | 'running' | 'pass' | 'fail' | 'skip';
  message?: string;
  duration?: number;
};

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

  // 两阶段选择：跟踪当前有 pending chip 的图片 key
  const [pendingChipKeys, setPendingChipKeys] = useState<Set<string>>(new Set());

  // 自动测试状态
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [isAutoTesting, setIsAutoTesting] = useState(false);
  const [testInterval, setTestInterval] = useState(800); // 毫秒
  const abortRef = useRef(false);

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

  // 两阶段选择：点击图片 → 在编辑器中插入/移除 pending chip
  const handleImageClick = useCallback((option: ImageOption) => {
    const composer = composerRef.current;
    if (!composer) return;

    if (pendingChipKeys.has(option.key)) {
      // 已有 pending chip，移除它
      composer.removeChipByKey(option.key);
      setPendingChipKeys((prev) => {
        const next = new Set(prev);
        next.delete(option.key);
        return next;
      });
      addOutput('pendingChip.remove()', { key: option.key, label: option.label });
    } else {
      // 插入 pending chip（灰色）
      composer.focus();
      composer.insertImageChip(option, { pending: true });
      setPendingChipKeys((prev) => {
        const next = new Set(prev);
        next.add(option.key);
        return next;
      });
      addOutput('pendingChip.insert()', { key: option.key, label: option.label });
    }
  }, [pendingChipKeys, addOutput]);

  // 直接插入 chip（用于自动测试等场景）
  const handleInsertChip = useCallback((option: ImageOption) => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.insertImageChip(option);
    addOutput('insertImageChip()', option);
  }, [addOutput]);

  const handleSubmit = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return true;
    // 先确认所有 pending chip（灰→蓝）
    composer.confirmPendingChips();
    setPendingChipKeys(new Set());
    const result = composer.getStructuredContent();
    addOutput('onSubmit()', result);
    composer.clear();
    return true;
  }, [addOutput]);

  const handleClear = useCallback(() => {
    composerRef.current?.clear();
    setPendingChipKeys(new Set());
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

  /**
   * 自动测试定义
   * 每个测试返回 { pass: boolean, message?: string }
   */
  const runAutoTests = useCallback(async () => {
    if (isAutoTesting) return;
    abortRef.current = false;
    setIsAutoTesting(true);

    const tests: Array<{
      name: string;
      run: () => Promise<{ pass: boolean; message?: string }>;
    }> = [
      {
        name: '插入单个 chip',
        run: async () => {
          const composer = composerRef.current;
          if (!composer) return { pass: false, message: 'composerRef 不存在' };
          composer.clear();
          composer.focus();
          composer.insertImageChip(MOCK_IMAGES[0]);
          await new Promise((r) => setTimeout(r, 100));
          const { imageRefs } = composer.getStructuredContent();
          if (imageRefs.length !== 1) {
            return { pass: false, message: `期望 1 个 imageRef，实际 ${imageRefs.length}` };
          }
          if (imageRefs[0].refId !== 1) {
            return { pass: false, message: `期望 refId=1，实际 ${imageRefs[0].refId}` };
          }
          return { pass: true };
        },
      },
      {
        name: '插入多个 chip',
        run: async () => {
          const composer = composerRef.current;
          if (!composer) return { pass: false, message: 'composerRef 不存在' };
          composer.clear();
          composer.focus();
          composer.insertImageChip(MOCK_IMAGES[0]);
          composer.insertImageChip(MOCK_IMAGES[1]);
          composer.insertImageChip(MOCK_IMAGES[2]);
          await new Promise((r) => setTimeout(r, 100));
          const { imageRefs } = composer.getStructuredContent();
          if (imageRefs.length !== 3) {
            return { pass: false, message: `期望 3 个 imageRef，实际 ${imageRefs.length}` };
          }
          return { pass: true };
        },
      },
      {
        name: 'imageRefs 返回正确',
        run: async () => {
          const composer = composerRef.current;
          if (!composer) return { pass: false, message: 'composerRef 不存在' };
          composer.clear();
          composer.focus();
          composer.insertText('测试文本 ');
          composer.insertImageChip(MOCK_IMAGES[1]);
          composer.insertText(' 更多文本');
          await new Promise((r) => setTimeout(r, 100));
          const { text, imageRefs } = composer.getStructuredContent();
          if (!text.includes('测试文本')) {
            return { pass: false, message: `文本内容不正确: ${text}` };
          }
          if (imageRefs.length !== 1 || imageRefs[0].refId !== 2) {
            return { pass: false, message: `imageRefs 不正确: ${JSON.stringify(imageRefs)}` };
          }
          return { pass: true };
        },
      },
      {
        name: '超长标签不溢出',
        run: async () => {
          const composer = composerRef.current;
          if (!composer) return { pass: false, message: 'composerRef 不存在' };
          composer.clear();
          composer.focus();
          // 使用带超长标签的图片
          composer.insertImageChip(MOCK_IMAGES[3]); // 超长标签
          await new Promise((r) => setTimeout(r, 100));
          const { imageRefs } = composer.getStructuredContent();
          if (imageRefs.length !== 1) {
            return { pass: false, message: `期望 1 个 imageRef，实际 ${imageRefs.length}` };
          }
          // 检查 chip 是否正常渲染（通过 DOM 检查宽度）
          const chips = document.querySelectorAll('[data-lexical-decorator="true"]');
          if (chips.length === 0) {
            return { pass: false, message: '未找到 chip DOM 元素' };
          }
          const chip = chips[chips.length - 1] as HTMLElement;
          if (chip.offsetWidth > 150) {
            return { pass: false, message: `chip 宽度过大: ${chip.offsetWidth}px` };
          }
          return { pass: true };
        },
      },
      {
        name: '窄容器 chip 正常',
        run: async () => {
          const composer = narrowComposerRef.current;
          if (!composer) return { pass: false, message: 'narrowComposerRef 不存在' };
          composer.clear();
          composer.focus();
          composer.insertImageChip(MOCK_IMAGES[0]);
          composer.insertImageChip(MOCK_IMAGES[1]);
          await new Promise((r) => setTimeout(r, 100));
          const { imageRefs } = composer.getStructuredContent();
          if (imageRefs.length !== 2) {
            return { pass: false, message: `期望 2 个 imageRef，实际 ${imageRefs.length}` };
          }
          return { pass: true };
        },
      },
      {
        name: 'clear() 清空内容',
        run: async () => {
          const composer = composerRef.current;
          if (!composer) return { pass: false, message: 'composerRef 不存在' };
          composer.insertText('一些内容');
          composer.insertImageChip(MOCK_IMAGES[0]);
          await new Promise((r) => setTimeout(r, 50));
          composer.clear();
          await new Promise((r) => setTimeout(r, 50));
          const { text, imageRefs } = composer.getStructuredContent();
          if (text.trim() !== '' || imageRefs.length !== 0) {
            return { pass: false, message: `clear 后内容不为空: text="${text}", refs=${imageRefs.length}` };
          }
          return { pass: true };
        },
      },
      {
        name: 'getPlainText() 返回文本',
        run: async () => {
          const composer = composerRef.current;
          if (!composer) return { pass: false, message: 'composerRef 不存在' };
          composer.clear();
          composer.focus();
          composer.insertText('Hello ');
          composer.insertImageChip(MOCK_IMAGES[0]);
          composer.insertText(' World');
          await new Promise((r) => setTimeout(r, 100));
          const plainText = composer.getPlainText();
          // chip 会被渲染为某种文本表示
          if (!plainText.includes('Hello') || !plainText.includes('World')) {
            return { pass: false, message: `plainText 不包含预期内容: ${plainText}` };
          }
          return { pass: true };
        },
      },
      {
        name: '重复引用处理',
        run: async () => {
          const composer = composerRef.current;
          if (!composer) return { pass: false, message: 'composerRef 不存在' };
          composer.clear();
          composer.focus();
          composer.insertImageChip(MOCK_IMAGES[0]);
          composer.insertText(' 和 ');
          composer.insertImageChip(MOCK_IMAGES[0]); // 同一张图片
          await new Promise((r) => setTimeout(r, 100));
          const { imageRefs } = composer.getStructuredContent();
          // 重复的 chip 应该都被记录
          if (imageRefs.length !== 2) {
            return { pass: false, message: `期望 2 个重复引用，实际 ${imageRefs.length}` };
          }
          return { pass: true };
        },
      },
    ];

    // 初始化测试结果
    setTestResults(tests.map((t) => ({ name: t.name, status: 'pending' })));

    // 逐个运行测试
    for (let i = 0; i < tests.length; i++) {
      if (abortRef.current) break;

      // 标记当前测试为 running
      setTestResults((prev) =>
        prev.map((r, idx) => (idx === i ? { ...r, status: 'running' } : r))
      );

      const start = Date.now();
      try {
        const result = await tests[i].run();
        const duration = Date.now() - start;
        setTestResults((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? { ...r, status: result.pass ? 'pass' : 'fail', message: result.message, duration }
              : r
          )
        );
      } catch (err) {
        const duration = Date.now() - start;
        setTestResults((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? { ...r, status: 'fail', message: `异常: ${String(err)}`, duration }
              : r
          )
        );
      }

      // 等待间隔
      if (i < tests.length - 1 && !abortRef.current) {
        await new Promise((r) => setTimeout(r, testInterval));
      }
    }

    // 清理
    composerRef.current?.clear();
    narrowComposerRef.current?.clear();
    setIsAutoTesting(false);
  }, [isAutoTesting, testInterval]);

  // 停止测试
  const stopAutoTests = useCallback(() => {
    abortRef.current = true;
    setIsAutoTesting(false);
  }, []);

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
            {/* 模拟画布 - 两阶段选择 */}
            <div style={{
              background: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: 12,
              border: '1px solid var(--border-default)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>模拟画布（点击图片 → 插入/移除灰色 chip）</span>
                {pendingChipKeys.size > 0 && (
                  <span style={{ color: 'rgba(156, 163, 175, 1)', fontSize: 10 }}>
                    待确认 {pendingChipKeys.size} 张
                    <button
                      onClick={() => {
                        // 清除所有 pending chips
                        pendingChipKeys.forEach((key) => {
                          composerRef.current?.removeChipByKey(key);
                        });
                        setPendingChipKeys(new Set());
                      }}
                      style={{
                        marginLeft: 6,
                        padding: '1px 4px',
                        fontSize: 9,
                        background: 'rgba(156, 163, 175, 0.2)',
                        border: '1px solid rgba(156, 163, 175, 0.3)',
                        borderRadius: 3,
                        color: 'rgba(156, 163, 175, 1)',
                        cursor: 'pointer',
                      }}
                    >
                      清除
                    </button>
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {MOCK_IMAGES.map(img => {
                  const hasPendingChip = pendingChipKeys.has(img.key);
                  return (
                    <div
                      key={img.key}
                      onClick={() => handleImageClick(img)}
                      style={{
                        cursor: 'pointer',
                        padding: 6,
                        background: hasPendingChip ? 'rgba(156, 163, 175, 0.15)' : 'var(--bg-base)',
                        borderRadius: 6,
                        border: `2px solid ${hasPendingChip ? 'rgba(156, 163, 175, 0.6)' : 'transparent'}`,
                        outline: '1px solid var(--border-default)',
                        transition: 'all 0.15s',
                        position: 'relative',
                      }}
                    >
                      {/* 已插入 pending chip 的遮罩 */}
                      {hasPendingChip && (
                        <div style={{
                          position: 'absolute',
                          top: 6,
                          left: 6,
                          right: 6,
                          bottom: 22,
                          background: 'rgba(156, 163, 175, 0.3)',
                          borderRadius: 4,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'white',
                          fontSize: 16,
                          fontWeight: 600,
                        }}>
                          ✓
                        </div>
                      )}
                      <img
                        src={img.src}
                        alt={img.label}
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 4,
                          objectFit: 'cover',
                          display: 'block',
                          opacity: hasPendingChip ? 0.7 : 1,
                        }}
                      />
                      <div style={{
                        fontSize: 9,
                        marginTop: 4,
                        color: hasPendingChip ? 'rgba(156, 163, 175, 1)' : 'var(--text-muted)',
                        maxWidth: 48,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        textAlign: 'center',
                        fontWeight: hasPendingChip ? 600 : 400,
                      }}>
                        #{img.refId}
                      </div>
                    </div>
                  );
                })}
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
                主输入框（灰色 chip = 待确认，发送时自动变蓝）
              </div>
              {/* 输入框容器 - pending chips 直接插入在编辑器中 */}
              <div
                style={{
                  background: 'var(--bg-base)',
                  borderRadius: 6,
                  padding: 10,
                  border: pendingChipKeys.size > 0
                    ? '1px solid rgba(156, 163, 175, 0.5)'
                    : '1px solid var(--border-default)',
                  transition: 'border-color 0.15s',
                  cursor: 'text',
                }}
                onClick={() => composerRef.current?.focus()}
              >
                <RichComposer
                  ref={composerRef}
                  placeholder="输入文字，点击上方图片插入引用..."
                  imageOptions={MOCK_IMAGES}
                  onChange={setCurrentText}
                  onSubmit={handleSubmit}
                  minHeight={40}
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

        {/* 验收清单 + 自动测试 */}
        <div style={{
          marginTop: 16,
          background: 'var(--bg-elevated)',
          borderRadius: 8,
          padding: 12,
          border: '1px solid var(--border-default)',
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              验收检查清单
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>间隔</span>
              <input
                type="range"
                min={200}
                max={2000}
                step={100}
                value={testInterval}
                onChange={(e) => setTestInterval(Number(e.target.value))}
                style={{ width: 60 }}
                disabled={isAutoTesting}
              />
              <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 40 }}>{testInterval}ms</span>
              {isAutoTesting ? (
                <Btn onClick={stopAutoTests} variant="danger" size="sm">停止</Btn>
              ) : (
                <Btn onClick={runAutoTests} size="sm">自动测试</Btn>
              )}
            </div>
          </div>

          {/* 手动检查项 */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>手动检查（需人工验证）</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
              <CheckItem label="@ 弹出下拉" />
              <CheckItem label="Enter 发送" />
              <CheckItem label="Shift+Enter 换行" />
            </div>
          </div>

          {/* 自动测试结果 */}
          {testResults.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
                自动测试结果
                {' '}
                <span style={{ color: 'rgba(34, 197, 94, 1)' }}>
                  {testResults.filter((t) => t.status === 'pass').length} 通过
                </span>
                {' / '}
                <span style={{ color: 'rgba(239, 68, 68, 1)' }}>
                  {testResults.filter((t) => t.status === 'fail').length} 失败
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {testResults.map((result, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 4,
                      fontSize: 11,
                      background:
                        result.status === 'pass'
                          ? 'rgba(34, 197, 94, 0.1)'
                          : result.status === 'fail'
                          ? 'rgba(239, 68, 68, 0.1)'
                          : result.status === 'running'
                          ? 'rgba(99, 102, 241, 0.1)'
                          : 'var(--bg-base)',
                      border: `1px solid ${
                        result.status === 'pass'
                          ? 'rgba(34, 197, 94, 0.3)'
                          : result.status === 'fail'
                          ? 'rgba(239, 68, 68, 0.3)'
                          : result.status === 'running'
                          ? 'rgba(99, 102, 241, 0.3)'
                          : 'var(--border-default)'
                      }`,
                    }}
                  >
                    <span style={{ width: 16, textAlign: 'center' }}>
                      {result.status === 'pass' && '✓'}
                      {result.status === 'fail' && '✗'}
                      {result.status === 'running' && '⋯'}
                      {result.status === 'pending' && '○'}
                    </span>
                    <span style={{
                      flex: 1,
                      color:
                        result.status === 'pass'
                          ? 'rgba(34, 197, 94, 1)'
                          : result.status === 'fail'
                          ? 'rgba(239, 68, 68, 1)'
                          : result.status === 'running'
                          ? 'rgba(99, 102, 241, 1)'
                          : 'var(--text-secondary)',
                    }}>
                      {result.name}
                    </span>
                    {result.duration !== undefined && (
                      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                        {result.duration}ms
                      </span>
                    )}
                    {result.message && result.status === 'fail' && (
                      <span style={{
                        fontSize: 9,
                        color: 'rgba(239, 68, 68, 0.8)',
                        maxWidth: 300,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={result.message}
                      >
                        {result.message}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
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
