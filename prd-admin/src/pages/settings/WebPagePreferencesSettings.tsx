import { useEffect, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Switch } from '@/components/design/Switch';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getUserPreferences, updateWebPageAskPreference } from '@/services';
import { toast } from '@/lib/toast';

/** 当前用户自己的网页托管默认行为；不需要管理员权限。 */
export function WebPagePreferencesSettings() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void getUserPreferences()
      .then((res) => {
        if (!alive) return;
        if (!res.success) {
          toast.error('读取失败', res.error?.message || '无法读取网页托管设置');
          return;
        }
        setEnabled(res.data.webPageAskEnabled === true);
      })
      .catch((error) => {
        if (alive) toast.error('读取失败', error instanceof Error ? error.message : '无法读取网页托管设置');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  const handleChange = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await updateWebPageAskPreference(next);
      if (!res.success) {
        toast.error('保存失败', res.error?.message || '无法保存网页托管设置');
        return;
      }
      setEnabled(next);
      toast.success('已保存', next ? '未单独设置的站点将默认开放提问' : '未单独设置的站点将默认关闭提问');
    } catch (error) {
      toast.error('保存失败', error instanceof Error ? error.message : '无法保存网页托管设置');
    } finally {
      setSaving(false);
    }
  };

  return (
    <GlassCard glow animated accentHue={218} className="h-full min-h-0 flex flex-col">
      <div className="mb-6">
        <h2 className="text-base font-semibold text-token-primary">网页托管设置</h2>
        <p className="mt-1 text-xs text-token-muted">这里的选择属于你自己，并会跨设备同步。</p>
      </div>

      {loading ? (
        <MapSectionLoader text="正在读取设置…" />
      ) : (
        <div
          className="flex items-start justify-between gap-5 rounded-xl p-4"
          style={{ background: 'var(--nested-block-bg)', border: '1px solid var(--nested-block-border)' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-token-primary">
              <MessageCircleQuestion size={16} />
              默认开放“向我提问”
            </div>
            <p className="mt-1.5 max-w-2xl text-xs leading-5 text-token-muted">
              系统临时默认关闭。打开后，未单独配置过提问开关的网页会允许访客提问；
              某个网页已经单独设置过时，仍以该网页自己的设置为准。
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleChange}
            disabled={saving}
            ariaLabel="默认开放向我提问"
          />
        </div>
      )}
    </GlassCard>
  );
}
