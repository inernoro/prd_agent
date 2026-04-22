import { useMemo, useState } from 'react';
import { Book, Check, Copy, Download, Package, Terminal } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  buildCurlForkSnippet,
  buildCurlListSnippet,
  buildCurlUploadSnippet,
  buildPythonSnippet,
  buildTypeScriptSnippet,
  resolveOpenApiBase,
} from './codeSnippets';
import {
  OFFICIAL_SKILL_MARKETPLACE_OPENAPI,
  downloadOfficialSkill,
  markOfficialSkillDownloaded,
} from './downloadOfficialSkill';

type SnippetLang = 'curl-list' | 'curl-fork' | 'curl-upload' | 'ts' | 'python';

const LANG_TABS: Array<{ key: SnippetLang; label: string }> = [
  { key: 'curl-list', label: 'curl · 列表' },
  { key: 'curl-fork', label: 'curl · 下载' },
  { key: 'curl-upload', label: 'curl · 上传' },
  { key: 'ts', label: 'TypeScript / Node' },
  { key: 'python', label: 'Python' },
];

export function GuideTab() {
  const [lang, setLang] = useState<SnippetLang>('curl-list');
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const baseUrl = useMemo(() => resolveOpenApiBase(), []);

  const handleDownloadSkill = async () => {
    setDownloading(true);
    try {
      await downloadOfficialSkill(OFFICIAL_SKILL_MARKETPLACE_OPENAPI);
      markOfficialSkillDownloaded();
      toast.success('已下载 marketplace-openapi.zip，解压到 ~/.claude/skills/ 即可使用');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败');
    } finally {
      setDownloading(false);
    }
  };

  const snippet = useMemo(() => {
    const PLACEHOLDER = 'YOUR_API_KEY';
    switch (lang) {
      case 'curl-list':
        return buildCurlListSnippet(PLACEHOLDER, baseUrl);
      case 'curl-fork':
        return buildCurlForkSnippet(PLACEHOLDER, baseUrl);
      case 'curl-upload':
        return buildCurlUploadSnippet(PLACEHOLDER, baseUrl);
      case 'ts':
        return buildTypeScriptSnippet(PLACEHOLDER, baseUrl);
      case 'python':
        return buildPythonSnippet(PLACEHOLDER, baseUrl);
    }
  }, [lang, baseUrl]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success('代码已复制，记得把 YOUR_API_KEY 换成真实明文');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败，请手动选中');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 第 0 步 —— 下载官方技能包（CTA 居首） */}
      <section
        className="rounded-xl px-4 py-3.5"
        style={{
          background:
            'linear-gradient(135deg, rgba(56, 189, 248, 0.14) 0%, rgba(129, 140, 248, 0.1) 100%)',
          border: '1px solid rgba(56, 189, 248, 0.4)',
          boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.06)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(56, 189, 248, 0.2)',
              border: '1px solid rgba(56, 189, 248, 0.4)',
            }}
          >
            <Package size={16} style={{ color: 'rgba(186, 230, 253, 1)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium mb-0.5" style={{ color: 'var(--text-primary)' }}>
              第 0 步：下载「海鲜市场开放接口」官方技能包
            </div>
            <div className="text-[11px] leading-relaxed mb-2.5" style={{ color: 'rgba(224, 242, 254, 0.78)' }}>
              没有这个技能包，AI 不知道怎么调用本平台的开放接口。
              下载后解压到 <code className="font-mono">~/.claude/skills/</code>，
              之后和 Key 一起喂给 AI 即可。
            </div>
            <button
              type="button"
              onClick={handleDownloadSkill}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: 'rgba(56, 189, 248, 0.22)',
                border: '1px solid rgba(56, 189, 248, 0.5)',
                color: 'rgba(224, 242, 254, 1)',
                cursor: downloading ? 'wait' : 'pointer',
              }}
            >
              <Download size={13} />
              {downloading ? '下载中…' : '下载 marketplace-openapi.zip'}
            </button>
          </div>
        </div>
      </section>

      {/* 快速上手 */}
      <section
        className="rounded-xl px-4 py-3"
        style={{
          background: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          backdropFilter: 'blur(16px)',
        }}
      >
        <div className="flex items-start gap-2">
          <Book size={16} style={{ color: 'rgba(186, 230, 253, 1)' }} className="mt-0.5 shrink-0" />
          <div className="text-xs leading-relaxed" style={{ color: 'rgba(224, 242, 254, 0.95)' }}>
            <div className="font-medium mb-1">三步接入海鲜市场开放接口</div>
            <ol className="space-y-0.5 list-decimal pl-4 opacity-95">
              <li>在"新建 Key" Tab 创建一个带 <code className="font-mono">marketplace.skills:read</code> 的 API Key，妥善保存明文。</li>
              <li>把明文 Key 设置为 AI 工作站/CI 的环境变量 <code className="font-mono">PRD_AGENT_API_KEY</code>。</li>
              <li>使用下方任一语言的代码片段调用；<code className="font-mono">Authorization: Bearer &lt;Key&gt;</code>。</li>
            </ol>
          </div>
        </div>
      </section>

      {/* 代码样本 */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-1 flex-wrap">
          {LANG_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setLang(tab.key)}
              className="px-2.5 py-1 rounded-lg text-[11px] transition-all"
              style={{
                background: lang === tab.key ? 'rgba(56, 189, 248, 0.18)' : 'rgba(255, 255, 255, 0.04)',
                border: `1px solid ${lang === tab.key ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.1)'}`,
                color: lang === tab.key ? 'rgba(186, 230, 253, 1)' : 'var(--text-secondary)',
              }}
            >
              {tab.label}
            </button>
          ))}
          <button
            type="button"
            onClick={handleCopy}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] transition-all hover:bg-white/5"
            style={{ color: 'rgba(186, 230, 253, 1)' }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制代码'}
          </button>
        </div>
        <pre
          className="rounded-xl px-4 py-3 text-[11px] font-mono overflow-x-auto leading-relaxed"
          style={{
            background: 'rgba(0, 0, 0, 0.4)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            color: 'rgba(226, 232, 240, 0.95)',
            maxHeight: '320px',
          }}
        >
          <code>{snippet}</code>
        </pre>
      </section>

      {/* 订阅与修改 */}
      <section
        className="rounded-xl px-4 py-3 text-xs leading-relaxed"
        style={{
          background: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          color: 'var(--text-secondary)',
        }}
      >
        <div className="flex items-center gap-1.5 mb-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          <Terminal size={14} />
          订阅、修改、续期
        </div>
        <ul className="space-y-1.5 list-disc pl-4">
          <li>
            <strong>订阅技能：</strong>列表接口支持 <code className="font-mono">sort=new</code> + 你自己的时间戳比对，
            轮询 <code className="font-mono">GET /api/open/marketplace/skills?sort=new&amp;limit=50</code> 即可当作"订阅最新技能"。
            在 AI Agent 里按 <code className="font-mono">items[0].createdAt</code> 对比本地 cursor 判断是否有新发布。
          </li>
          <li>
            <strong>修改技能：</strong>现阶段只支持"删除后重传"（调用方删除接口未开放给 Open API，请在 Web UI
            里删除旧版本后用 <code className="font-mono">/upload</code> 重新上传）。后续会加 PATCH 端点。
          </li>
          <li>
            <strong>续期 Key：</strong>在"我的 Key" Tab 点"续期一年"即可延长有效期。响应头
            <code className="font-mono"> X-AgentApiKey-ExpiringSoon </code>
            在到期前 30 天内变为 <code className="font-mono">true</code>，SDK 应监听此头并提示调用方。
          </li>
          <li>
            <strong>不会动不动就 403：</strong>Key 过期后有 <em>7 天宽限期</em>，期间请求正常响应，
            仅在响应头 <code className="font-mono">X-AgentApiKey-Expiring=true</code> 提示。超过宽限期才真正 401。
          </li>
          <li>
            <strong>findmapskills 技能：</strong>如果你用 Claude Code，把本仓库 <code className="font-mono">.claude/skills/findmapskills/</code>
            作为技能目录（或手动复制到 <code className="font-mono">~/.claude/skills/</code>），
            就可以用一句"找个海鲜市场的技能来做 X"触发 AI 自动调用本开放接口搜索。
          </li>
        </ul>
      </section>
    </div>
  );
}
