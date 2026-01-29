/**
 * TwoPhaseRichComposer - 两阶段选择富文本编辑器
 *
 * 功能：
 * 1. 点击外部画布图片 → 插入灰色 pending chip（预选）
 * 2. 点击输入框容器 → 确认 pending chips（灰→蓝）
 * 3. 发送前自动确认所有 pending chips
 *
 * 使用方式：
 * - 外部画布通过 ref.preselectImage() 预选图片
 * - 组件自动管理 pending 状态
 * - 通过 onPendingKeysChange 回调通知外部（用于画布显示 pending 遮罩）
 */
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { RichComposer, type RichComposerRef, type ImageOption } from './index';

export interface TwoPhaseRichComposerProps {
  /** 占位符 */
  placeholder?: string;
  /** 可选的图片列表（用于 @ 下拉） */
  imageOptions: ImageOption[];
  /** 内容变化回调 */
  onChange?: (text: string) => void;
  /** Enter 发送回调（返回 true 阻止默认换行） */
  onSubmit?: () => boolean | void;
  /** 粘贴图片回调 */
  onPasteImage?: (file: File) => boolean | void;
  /** 最小高度 */
  minHeight?: number;
  /** 最大高度 */
  maxHeight?: number | string;
  /** RichComposer 样式 */
  style?: React.CSSProperties;
  /** 类名 */
  className?: string;
  /** pending keys 变化回调（用于外部画布显示 pending 遮罩） */
  onPendingKeysChange?: (keys: Set<string>) => void;
}

export interface TwoPhaseRichComposerRef {
  /** 获取纯文本内容 */
  getPlainText: () => string;
  /** 获取结构化内容 */
  getStructuredContent: () => { text: string; imageRefs: Array<{ canvasKey: string; refId: number }> };
  /** 清空编辑器（同时清空 pending） */
  clear: () => void;
  /** 聚焦编辑器 */
  focus: () => void;
  /** 插入图片 chip（直接插入为就绪状态） */
  insertImageChip: (option: ImageOption, opts?: { ready?: boolean }) => void;
  /** 插入文本 */
  insertText: (text: string) => void;
  /** 将所有待选 chip 标记为就绪 */
  markChipsReady: () => void;
  /** 移除指定 key 的 chip */
  removeChipByKey: (canvasKey: string) => void;
  /** 【两阶段】预选图片（插入灰色 pending chip） */
  preselectImage: (option: ImageOption) => void;
  /** 【两阶段】确认所有 pending chips（灰→蓝） */
  confirmPending: () => void;
  /** 【两阶段】清除所有 pending chips（不发送） */
  clearPending: () => void;
  /** 【两阶段】获取当前 pending keys */
  getPendingKeys: () => Set<string>;
  /** 【两阶段】检查是否有 pending */
  hasPending: () => boolean;
}

export const TwoPhaseRichComposer = forwardRef<TwoPhaseRichComposerRef, TwoPhaseRichComposerProps>(
  function TwoPhaseRichComposer(props, ref) {
    const {
      placeholder,
      imageOptions,
      onChange,
      onSubmit,
      onPasteImage,
      minHeight = 40,
      maxHeight = 150,
      style,
      className,
      onPendingKeysChange,
    } = props;

    const composerRef = useRef<RichComposerRef>(null);

    // 两阶段选择：跟踪当前有 pending chip 的图片 key
    const [pendingChipKeys, setPendingChipKeys] = useState<Set<string>>(new Set());

    // 更新 pending keys 并通知外部
    const updatePendingKeys = useCallback((keys: Set<string>) => {
      setPendingChipKeys(keys);
      onPendingKeysChange?.(keys);
    }, [onPendingKeysChange]);

    // 预选图片（两阶段第一步）
    const preselectImage = useCallback((option: ImageOption) => {
      const composer = composerRef.current;
      if (!composer) return;

      // 如果点击的是同一张图片（已经是 pending），不做任何操作
      if (pendingChipKeys.has(option.key)) return;

      // 移除所有现有的 pending chips（替换逻辑）
      pendingChipKeys.forEach((key) => {
        composer.removeChipByKey(key);
      });

      // 插入新的 pending chip（灰色，不传 ready）
      composer.insertImageChip(option);
      updatePendingKeys(new Set([option.key]));
    }, [pendingChipKeys, updatePendingKeys]);

    // 确认 pending chips（灰→蓝）
    const confirmPending = useCallback(() => {
      const composer = composerRef.current;
      if (!composer) return;

      if (pendingChipKeys.size > 0) {
        composer.markChipsReady();
        updatePendingKeys(new Set());
      }
    }, [pendingChipKeys, updatePendingKeys]);

    // 清除 pending chips
    const clearPending = useCallback(() => {
      const composer = composerRef.current;
      if (!composer) return;

      pendingChipKeys.forEach((key) => {
        composer.removeChipByKey(key);
      });
      updatePendingKeys(new Set());
    }, [pendingChipKeys, updatePendingKeys]);

    // 点击输入框容器时确认 pending chips
    const handleContainerClick = useCallback(() => {
      confirmPending();
      composerRef.current?.focus();
    }, [confirmPending]);

    // 发送时先确认 pending
    const handleSubmit = useCallback(() => {
      confirmPending();
      return onSubmit?.();
    }, [confirmPending, onSubmit]);

    // 清空时也清空 pending
    const handleClear = useCallback(() => {
      composerRef.current?.clear();
      updatePendingKeys(new Set());
    }, [updatePendingKeys]);

    // 暴露 ref 方法
    useImperativeHandle(ref, () => ({
      getPlainText: () => composerRef.current?.getPlainText() ?? '',
      getStructuredContent: () => composerRef.current?.getStructuredContent() ?? { text: '', imageRefs: [] },
      clear: handleClear,
      focus: () => composerRef.current?.focus(),
      insertImageChip: (option, opts) => composerRef.current?.insertImageChip(option, opts),
      insertText: (text) => composerRef.current?.insertText(text),
      markChipsReady: () => composerRef.current?.markChipsReady(),
      removeChipByKey: (key) => composerRef.current?.removeChipByKey(key),
      preselectImage,
      confirmPending,
      clearPending,
      getPendingKeys: () => pendingChipKeys,
      hasPending: () => pendingChipKeys.size > 0,
    }), [pendingChipKeys, preselectImage, confirmPending, clearPending, handleClear]);

    const hasPending = pendingChipKeys.size > 0;

    return (
      <div
        onClick={handleContainerClick}
        className={className}
        style={{
          cursor: 'text',
          background: 'var(--bg-base)',
          borderRadius: 6,
          padding: 10,
          border: hasPending
            ? '1px solid rgba(156, 163, 175, 0.5)'
            : '1px solid var(--border-default)',
          transition: 'border-color 0.15s',
        }}
      >
        <RichComposer
          ref={composerRef}
          placeholder={hasPending ? '点击此处确认选择，或继续输入...' : placeholder}
          imageOptions={imageOptions}
          onChange={onChange}
          onSubmit={handleSubmit}
          onPasteImage={onPasteImage}
          minHeight={minHeight}
          maxHeight={maxHeight}
          style={style}
        />
      </div>
    );
  }
);

export default TwoPhaseRichComposer;
