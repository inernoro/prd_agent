import { Plus, Upload, Rss } from 'lucide-react';

// 知识库空状态 + 首访引导（纯展示组件）
// 颜色全部走 CSS 变量，保证暗/亮主题都清晰；禁止任何 emoji 字符。

export interface DocEmptyStateProps {
  title?: string; // 默认 "这是你的知识库"
  description?: string; // 默认 "汇总文档，按结论与时间归档，支持全文搜索与标签筛选。"
  onCreateDocument?: () => void;
  onUploadFile?: () => void;
  onAddSubscription?: () => void;
}

// 「3 步开始」卡片里的单行
function StepRow({ index, text }: { index: number; text: string }) {
  return (
    <div className="flex items-center gap-2">
      {/* 圆形数字徽标 */}
      <span
        className="flex shrink-0 items-center justify-center rounded-full"
        style={{
          width: 16,
          height: 16,
          background: 'var(--accent-soft, rgba(129,140,248,0.12))',
          color: 'var(--accent-primary, #818cf8)',
          fontSize: 9,
          fontWeight: 700,
        }}
      >
        {index}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{text}</span>
    </div>
  );
}

export function DocEmptyState(props: DocEmptyStateProps) {
  const {
    title = '这是你的知识库',
    description = '汇总文档，按结论与时间归档，支持全文搜索与标签筛选。',
    onCreateDocument,
    onUploadFile,
    onAddSubscription,
  } = props;

  // 至少有一个回调时才渲染 CTA 行
  const hasCta = !!(onCreateDocument || onUploadFile || onAddSubscription);

  return (
    <div
      className="flex w-full flex-col items-center justify-center text-center"
      style={{ padding: 24 }}
    >
      {/* 1. 顶部线框插画：文档 + 放大镜 */}
      <svg
        width={60}
        height={60}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ color: 'var(--text-muted)', opacity: 0.5, marginBottom: 14 }}
        aria-hidden="true"
      >
        {/* 文档外框 */}
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        {/* 折角 */}
        <path d="M14 2v6h6" />
        {/* 放大镜圆 */}
        <circle cx={12} cy={13} r={2.6} />
        {/* 放大镜手柄 */}
        <path d="M14 15l2 2" />
      </svg>

      {/* 2. 标题 */}
      <h3
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: 'var(--text-primary)',
          marginBottom: 6,
        }}
      >
        {title}
      </h3>

      {/* 3. 说明 */}
      <p
        style={{
          fontSize: 13,
          color: 'var(--text-muted)',
          maxWidth: 340,
          lineHeight: 1.6,
          marginBottom: 14,
        }}
      >
        {description}
      </p>

      {/* 4. CTA 按钮行：仅渲染存在的回调 */}
      {hasCta && (
        <div className="flex flex-wrap items-center justify-center gap-2" style={{ marginBottom: 14 }}>
          {onCreateDocument && (
            <button
              type="button"
              onClick={onCreateDocument}
              className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-90"
              style={{
                background: 'var(--accent-primary, #818cf8)',
                color: '#fff',
                borderRadius: 8,
                padding: '7px 14px',
                fontSize: 13,
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Plus size={15} />
              新建文档
            </button>
          )}
          {onUploadFile && (
            <button
              type="button"
              onClick={onUploadFile}
              className="inline-flex items-center gap-1.5 transition-colors"
              style={{
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-faint)',
                borderRadius: 8,
                padding: '7px 14px',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <Upload size={15} />
              上传文件
            </button>
          )}
          {onAddSubscription && (
            <button
              type="button"
              onClick={onAddSubscription}
              className="inline-flex items-center gap-1.5 transition-colors"
              style={{
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-faint)',
                borderRadius: 8,
                padding: '7px 14px',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <Rss size={15} />
              添加订阅源
            </button>
          )}
        </div>
      )}

      {/* 5. 「3 步开始」卡片 */}
      <div
        className="w-full text-left"
        style={{
          maxWidth: 340,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-faint)',
          borderRadius: 12,
          padding: 12,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginBottom: 10,
          }}
        >
          3 步开始
        </div>
        <div className="flex flex-col gap-2.5">
          <StepRow index={1} text="新建或上传文档" />
          <StepRow index={2} text="给文档打标签便于归类" />
          <StepRow index={3} text="生成只读分享链接发给同事" />
        </div>
      </div>
    </div>
  );
}
