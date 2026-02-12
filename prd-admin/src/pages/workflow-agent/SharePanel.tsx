import { useEffect, useState } from 'react';
import { ArrowLeft, Link2, Copy, Trash2, Eye, RefreshCw } from 'lucide-react';
import { useWorkflowStore } from '@/stores/workflowStore';
import { revokeShare } from '@/services';

export function SharePanel() {
  const { shares, loading, setViewMode, loadShares } = useWorkflowStore();

  useEffect(() => {
    loadShares();
  }, [loadShares]);

  const handleCopy = async (token: string) => {
    const url = `${window.location.origin}/s/${token}`;
    await navigator.clipboard.writeText(url);
    alert('链接已复制');
  };

  const handleRevoke = async (shareId: string) => {
    if (!confirm('确定撤销此分享链接？')) return;
    await revokeShare(shareId);
    loadShares();
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setViewMode('list')}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-semibold">分享管理</h1>
        </div>
        <button onClick={loadShares} className="p-1.5 rounded-md hover:bg-accent" title="刷新">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Loading */}
      {loading && <div className="text-center py-8 text-muted-foreground text-sm">加载中...</div>}

      {/* Empty */}
      {!loading && shares.length === 0 && (
        <div className="text-center py-12 space-y-2">
          <Link2 className="w-10 h-10 mx-auto text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">暂无分享链接</p>
          <p className="text-xs text-muted-foreground/50">在执行详情页点击「分享」按钮创建链接</p>
        </div>
      )}

      {/* Share list */}
      <div className="space-y-2">
        {shares.map((link) => (
          <div
            key={link.id}
            className="rounded-lg border border-border p-4 bg-card flex items-center gap-4"
          >
            <Link2 className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium truncate">{link.title || '未命名'}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                  link.accessLevel === 'public'
                    ? 'bg-green-500/10 text-green-600'
                    : 'bg-yellow-500/10 text-yellow-600'
                }`}>
                  {link.accessLevel === 'public' ? '公开' : '需登录'}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="font-mono">/s/{link.token}</span>
                <span className="flex items-center gap-0.5">
                  <Eye className="w-2.5 h-2.5" /> {link.viewCount}
                </span>
                <span>{new Date(link.createdAt).toLocaleString('zh-CN')}</span>
                {link.expiresAt && (
                  <span className={new Date(link.expiresAt) < new Date() ? 'text-red-500' : ''}>
                    过期: {new Date(link.expiresAt).toLocaleDateString('zh-CN')}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => handleCopy(link.token)}
                className="p-1.5 rounded hover:bg-accent"
                title="复制链接"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleRevoke(link.id)}
                className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                title="撤销"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
