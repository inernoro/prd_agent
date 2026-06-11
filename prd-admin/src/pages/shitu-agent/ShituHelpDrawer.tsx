import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ShituHelpDrawer({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const drawer = (
    <div
      className="fixed inset-0 z-[100] flex justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <aside
        className="h-full border-l border-white/10 bg-[#0f1014] shadow-2xl flex flex-col"
        style={{ width: 'min(92vw, 520px)', maxHeight: '100vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">识途使用帮助</h2>
            <p className="mt-1 text-xs text-white/45">新人文化与制度问答 — 严格基于知识库回答，不杜撰。</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-white/55">
            <X className="w-4 h-4" />
          </button>
        </header>

        <div
          className="flex-1 px-5 py-4 space-y-4 text-sm text-white/75"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">识途是做什么的？</h3>
            <p className="text-white/65 leading-relaxed">
              面向新人的文化与制度问答助手。与「学习中心」教你怎么用系统不同，识途回答的是公司文化、历史教训、规章制度和表彰案例。
              回答只依据当前分类知识库，没有资料会明确说「无法回答」。
            </p>
          </section>

          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">推荐使用路径</h3>
            <ol className="list-decimal list-inside space-y-1.5 text-white/65">
              <li>先选顶部分类 Tab：企业文化 / 事故教训 / 规章制度 / 奖赏表彰。</li>
              <li>切到「知识库」上传或维护该分类的资料（需管理员权限）。</li>
              <li>回到「问答」，点示例问题或直接输入，支持多轮对话。</li>
              <li>切换分类 Tab 会自动新开对话，避免上下文串台。</li>
            </ol>
          </section>

          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">四个分类怎么用</h3>
            <div className="space-y-2 text-white/65">
              <p><span className="text-sky-200/90">企业文化：</span>价值观、使命愿景、协作习惯与行为准则。</p>
              <p><span className="text-sky-200/90">事故教训：</span>历史事故复盘、根因与规避措施，语气严肃。</p>
              <p><span className="text-sky-200/90">规章制度：</span>考勤、请假、报销、合规流程等制度条文。</p>
              <p><span className="text-sky-200/90">奖赏表彰：</span>评优标准、表彰案例与获奖说明。</p>
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">问答区说明</h3>
            <ul className="list-disc list-inside space-y-1.5 text-white/65">
              <li>自动挂载当前分类知识库，无需手动选参考资料。</li>
              <li>回答中带 [1][2] 脚注，对应下方引用列表。</li>
              <li>顶部显示当前调用的模型名称（流式开始后可见）。</li>
              <li>Cmd/Ctrl + Enter 发送；「新对话」可清空当前分类会话。</li>
            </ul>
          </section>

          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">知识库维护</h3>
            <p className="text-white/65 leading-relaxed">
              知识库内嵌在识途页面内，不会出现在左侧「文档空间」个人列表。
              有「识途-管理」权限的用户可在各分类「知识库」Tab 上传文档；普通用户只读浏览。
            </p>
          </section>
        </div>
      </aside>
    </div>
  );

  return createPortal(drawer, document.body);
}
