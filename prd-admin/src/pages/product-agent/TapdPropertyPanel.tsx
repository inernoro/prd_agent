/** TAPD 风格属性栏：左侧标签 + 右侧控件，紧凑行布局。 */
export function TapdPropertyPanel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-token-subtle bg-[#13151a] overflow-hidden lg:sticky lg:top-3">
      {title && (
        <div className="px-3 py-2 text-[12px] font-medium text-token-secondary border-b border-token-subtle bg-token-nested">
          {title}
        </div>
      )}
      <div className="px-3 py-1">{children}</div>
    </div>
  );
}

export function TapdPropertyRow({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-token-subtle/[0.06] last:border-b-0 min-h-[44px]">
      <div className="w-[92px] shrink-0 pt-2 text-[13px] text-token-muted text-right leading-snug">
        {label}
        {required && <span className="text-red-300/80 ml-0.5">*</span>}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
