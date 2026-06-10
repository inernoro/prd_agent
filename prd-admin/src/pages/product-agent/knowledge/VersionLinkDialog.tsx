/**
 * 关联版本对话框 — 把一条知识关联到产品的多个版本（N:N，存 entry.versionIds）。
 * 版本详情据此「调取」知识，符合「版本中只调取、不直接新增」的模型。
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, X } from 'lucide-react';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import type { ProductVersion } from '../types';
import { VERSION_LIFECYCLE_LABEL } from '../types';

export function VersionLinkDialog({
  entry, versions, onClose, onSave,
}: {
  entry: DocumentEntry;
  versions: ProductVersion[];
  onClose: () => void;
  onSave: (versionIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(entry.versionIds ?? []));
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="rounded-xl border border-white/10 bg-[#16181d] flex flex-col"
        style={{ width: 440, maxWidth: '92vw', maxHeight: '76vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <GitBranch size={14} className="text-purple-300" /> 关联版本
          </h2>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={16} /></button>
        </div>
        <div className="px-4 pt-3 text-xs text-white/45 shrink-0 truncate">「{entry.title}」将在勾选的版本中可被调取</div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5" style={{ minHeight: 0, overscrollBehavior: 'contain' }}>
          {versions.length === 0 ? (
            <div className="text-xs text-white/35 text-center py-8">该产品还没有版本。先去「版本」tab 创建版本，再回来关联。</div>
          ) : (
            versions.map((v) => (
              <label key={v.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5 cursor-pointer hover:bg-white/[0.06]">
                <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} className="accent-cyan-500" />
                <span className="text-sm text-white/85 flex-1 truncate">{v.versionName}</span>
                <span className="text-[10px] text-white/35 shrink-0">{VERSION_LIFECYCLE_LABEL[v.lifecycle] ?? v.lifecycle}</span>
              </label>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/10 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">取消</button>
          <button
            onClick={() => onSave(Array.from(selected))}
            className="px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm hover:bg-cyan-500/30"
          >
            保存（{selected.size} 个版本）
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
