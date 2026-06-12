/** TAPD 风格属性栏：左侧标签 + 右侧控件，紧凑行布局。 */
export function TapdPropertyPanel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#13151a] overflow-hidden lg:sticky lg:top-3">
      {title && (
        <div className="px-3 py-2 text-[12px] font-medium text-white/55 border-b border-white/8 bg-white/[0.02]">
          {title}
        </div>
      )}
      <div className="px-3 py-1">{children}</div>
    </div>
  );
}

export function TapdPropertyRow({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-2.5 border-b border-white/[0.06] last:border-b-0 min-h-[40px]">
      <div className="w-[68px] shrink-0 pt-1.5 text-[12px] text-white/45 text-right leading-snug">
        {label}
        {required && <span className="text-red-300/80 ml-0.5">*</span>}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
