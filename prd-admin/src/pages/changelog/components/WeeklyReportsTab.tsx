import { useEffect, useState, useCallback } from 'react';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import { Button } from '@/components/design/Button';
import { Github, RefreshCw, Loader2, Link as LinkIcon, Database } from 'lucide-react';
import { 
  listDocumentStoresWithPreview, 
  createDocumentStore, 
  addGitHubSubscription,
  listDocumentEntries,
  triggerSync,
  getDocumentContent
} from '@/services';
import type { DocumentStoreWithPreview, DocumentEntry } from '@/services/contracts/documentStore';
import type { EntryPreview } from '@/components/doc-browser/fileTypeRegistry';
import { toast } from '@/lib/toast';

const STORE_NAME = 'map周报';

export function WeeklyReportsTab() {
  const [store, setStore] = useState<DocumentStoreWithPreview | null>(null);
  const [subEntry, setSubEntry] = useState<DocumentEntry | null>(null);
  const [loading, setLoading] = useState(true);
  
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  
  // Setup inputs
  const [repoUrl, setRepoUrl] = useState('');
  const [includeGlob, setIncludeGlob] = useState('report*.md');
  const [configuring, setConfiguring] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const checkStore = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listDocumentStoresWithPreview(1, 100);
      if (res.success) {
        const found = res.data.items.find((s) => s.name === STORE_NAME);
        if (found) {
          setStore(found);
          // 查找该知识库下面的 github 订阅条目，为了支持“手动更新”按钮
          const er = await listDocumentEntries(found.id, 1, 500, undefined, undefined, undefined, true);
          if (er.success) {
            setEntries(er.data.items);
            const ghEntry = er.data.items.find(e => e.sourceType === 'github_directory');
            if (ghEntry) setSubEntry(ghEntry);
          }
        }
      }
    } catch {
      // 忽略后端挂掉
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    checkStore();
  }, [checkStore]);

  const handleSetup = async () => {
    if (!repoUrl.trim() || !repoUrl.includes('github.com')) {
      toast.error('请输入有效的 GitHub URL', '例如：https://github.com/my-org/my-repo/tree/main/doc');
      return;
    }
    setConfiguring(true);
    try {
      // 1. 创建周报专用知识库
      const storeRes = await createDocumentStore({ 
        name: STORE_NAME, 
        description: '自动为您同步周报的知识库',
        isPublic: false
      });
      if (storeRes.success) {
        const storeId = storeRes.data.id;
        // 2. 添加 GitHub 订阅 (间隔1440分钟=每天更新)
        const subRes = await addGitHubSubscription(storeId, {
          title: 'MAP 自动同步',
          githubUrl: repoUrl.trim(),
          syncIntervalMinutes: 1440,
          includeGlob: includeGlob.trim(),
        });

        if (subRes.success) {
          toast.success('配置成功', '后端正在拉取文件...');
          setTimeout(() => checkStore(), 1000);
        } else {
          toast.error('配置订阅引发错误', subRes.error?.message);
        }
      } else {
        toast.error('创建失败', storeRes.error?.message);
      }
    } catch (e: any) {
      toast.error('网络或服务器错', e?.message);
    }
    setConfiguring(false);
  };

  const handleManualSync = async () => {
    if (!subEntry) return;
    setSyncing(true);
    try {
      const res = await triggerSync(subEntry.id);
      if (res.success) {
        toast.success('已触发后台同步', '网络正常时，稍后数据即会更新。如果网络较差则会在后台静默重试。');
      } else {
        toast.error('触发失败', res.error?.message);
      }
    } catch {
      toast.error('网络存在异常', '无法立即连接到控制总线，但您的每日更新策略仍在生效中');
    }
    // 防止快速狂点
    setTimeout(() => setSyncing(false), 2000);
  };

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
    const res = await getDocumentContent(entryId);
    if (!res.success) return null;
    return {
      text: res.data.hasContent ? res.data.content : null,
      fileUrl: res.data.fileUrl,
      contentType: res.data.contentType,
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-indigo-400">
        <Loader2 className="animate-spin" size={24} />
      </div>
    );
  }

  // == 首次配置页 ==
  if (!store) {
    return (
      <div className="mt-8 mx-auto max-w-xl rounded-2xl p-8"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
        }}
      >
        <div className="flex flex-col items-center text-center gap-4 mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: 'rgba(168,85,247,0.1)',
              border: '1px solid rgba(168,85,247,0.25)',
              color: '#d8b4fe'
            }}
          >
            <Github size={32} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white tracking-wide mb-2">配置「map周报」订阅源</h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              只需要输入含有您报告的 GitHub 链接 (例如指向 <code>/doc</code> 目录的地址)，<br/>
              系统将为您创建一个专属知识库，并将每日自动抓取、智能处理。
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
              <LinkIcon size={12} />
              GitHub 目标地址
            </label>
            <input 
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/tree/main/doc"
              className="w-full h-11 px-4 rounded-xl outline-none text-[13px] font-mono transition-all"
              style={{
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
              }}
              onFocus={(e) => e.target.style.borderColor = 'rgba(168,85,247,0.5)'}
              onBlur={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
            />
          </div>

          <div className="flex flex-col gap-2 relative">
            <label className="text-xs font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-1.5 pt-1">
              模糊匹配 (Glob 文件约束)
            </label>
            <input 
              value={includeGlob}
              onChange={(e) => setIncludeGlob(e.target.value)}
              placeholder="例如：report*.md (为空则匹配所有 .md 文件)"
              className="w-full h-11 px-4 rounded-xl outline-none text-[13px] font-mono transition-all"
              style={{
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
              }}
              onFocus={(e) => e.target.style.borderColor = 'rgba(168,85,247,0.5)'}
              onBlur={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
            />
          </div>
          
          <Button 
            variant="primary" 
            className="w-full h-11 mt-2 text-[13px] font-bold rounded-xl flex items-center justify-center gap-2"
            style={{
              background: 'linear-gradient(135deg, #a855f7 0%, #7e22ce 100%)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 4px 12px rgba(168,85,247,0.3)',
            }}
            onClick={handleSetup}
            disabled={configuring}
          >
            {configuring ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
            {configuring ? '正在构建库并下达订阅指令...' : '保存至系统数据库并开始拉取'}
          </Button>

          <p className="text-[11px] text-gray-500 text-center mt-2 flex items-center justify-center gap-1.5">
            <RefreshCw size={10} />
            设置成功后，如果网络不佳也会在后台静默重试更新，不会卡死
          </p>
        </div>
      </div>
    );
  }

  // == 完整展示页 (复用 DocBrowser) ==
  return (
    <div className="flex flex-col h-[75vh] min-h-[500px]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3 pl-1">
          <div className="px-2.5 py-1 rounded-md text-[11px] font-bold font-mono tracking-wider"
            style={{
              background: 'rgba(168, 85, 247, 0.1)',
              border: '1px solid rgba(168, 85, 247, 0.3)',
              color: '#d8b4fe'
            }}
          >
            ● LIVE
          </div>
          <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            归档通道：{STORE_NAME}
          </span>
        </div>
        
        {subEntry && (
          <Button 
            variant="ghost" 
            size="xs" 
            onClick={handleManualSync} 
            disabled={syncing}
            className="rounded-lg text-[12px] h-8 px-3 ml-auto transition-colors bg-white/5 hover:bg-white/10"
            style={{ color: 'var(--text-secondary)' }}
          >
            <RefreshCw size={14} className={`mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
            强制手动触发更新
          </Button>
        )}
      </div>
      
      <div className="flex-1 min-h-0 rounded-2xl overflow-hidden relative"
        style={{
          background: 'rgba(0, 0, 0, 0.25)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          boxShadow: 'inset 0 0 40px rgba(0,0,0,0.2)'
        }}
      >
        <DocBrowser 
          entries={entries}
          selectedEntryId={selectedEntryId}
          onSelectEntry={setSelectedEntryId}
          loadContent={loadContent}
        />
      </div>
    </div>
  );
}
