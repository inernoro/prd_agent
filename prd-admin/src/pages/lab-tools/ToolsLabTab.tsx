import { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Send } from 'lucide-react';
import { migrateVisualSubmissions, migrateLiterarySubmissions } from '@/services/real/submissions';
import { toast } from '@/lib/toast';

interface MigrateResult {
  type: 'visual' | 'literary';
  username: string;
  total: number;
  alreadySubmitted: number;
  newlySubmitted: number;
}

export default function ToolsLabTab() {
  const [username, setUsername] = useState('admin');
  const [migrating, setMigrating] = useState(false);
  const [results, setResults] = useState<MigrateResult[]>([]);

  const handleMigrate = async () => {
    if (!username.trim()) {
      toast.warning('请输入用户名');
      return;
    }
    setMigrating(true);
    setResults([]);
    try {
      // 1. 视觉创作迁移
      const visualRes = await migrateVisualSubmissions(username.trim());
      if (visualRes.success) {
        setResults((prev) => [
          ...prev,
          {
            type: 'visual',
            username: visualRes.data.username,
            total: visualRes.data.totalAssets,
            alreadySubmitted: visualRes.data.alreadySubmitted,
            newlySubmitted: visualRes.data.newlySubmitted,
          },
        ]);
      }

      // 2. 文学创作迁移
      const literaryRes = await migrateLiterarySubmissions(username.trim());
      if (literaryRes.success) {
        setResults((prev) => [
          ...prev,
          {
            type: 'literary',
            username: literaryRes.data.username,
            total: literaryRes.data.totalWorkspaces,
            alreadySubmitted: literaryRes.data.alreadySubmitted,
            newlySubmitted: literaryRes.data.newlySubmitted,
          },
        ]);
      }

      toast.success('迁移完成');
    } catch {
      toast.error('迁移失败，请查看控制台');
    } finally {
      setMigrating(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 p-4">
      <GlassCard className="p-6 space-y-4">
        <div className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          <Send size={18} />
          历史素材批量投稿
        </div>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          将指定用户的历史视觉创作图片和文学创作作品一次性投稿到作品广场。
          操作具有幂等性，已投稿的素材不会重复投稿。投稿时间按原始创作时间排列。
        </p>

        <div className="flex items-center gap-3">
          <label className="text-sm shrink-0" style={{ color: 'var(--text-secondary)' }}>用户名</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="flex-1 h-8 px-3 rounded-md text-sm"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'var(--text-primary)',
            }}
            placeholder="admin"
          />
          <Button
            size="sm"
            variant="primary"
            onClick={handleMigrate}
            disabled={migrating}
          >
            {migrating ? '迁移中…' : '开始迁移'}
          </Button>
        </div>

        {results.length > 0 && (
          <div className="space-y-2 pt-2">
            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>迁移结果</div>
            <table className="w-full text-sm" style={{ color: 'var(--text-secondary)' }}>
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                  <th className="py-1 pr-4">类型</th>
                  <th className="py-1 pr-4">总素材</th>
                  <th className="py-1 pr-4">已投稿</th>
                  <th className="py-1">新投稿</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.type}>
                    <td className="py-1 pr-4">{r.type === 'visual' ? '视觉创作' : '文学创作'}</td>
                    <td className="py-1 pr-4">{r.total}</td>
                    <td className="py-1 pr-4">{r.alreadySubmitted}</td>
                    <td className="py-1" style={{ color: r.newlySubmitted > 0 ? 'rgba(16, 185, 129, 0.9)' : undefined }}>
                      {r.newlySubmitted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
