import { useEffect, useState } from 'react';
import { getSiteAskConfig } from '@/services/real/webPages';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import AskPanel from './AskPanel';

interface Props {
  siteId: string;
  title: string;
}

/**
 * 站内预览弹窗里的提问面板（嵌在右侧 aside 中，不是浮层）。
 *
 * 与分享页的差别只在开场问题的来源：分享页的问题由后端随分享视图算好下发
 * （分享自选优先），站内没有分享链接这一层，直接用站点题库。
 */
export default function AskPanelInline({ siteId, title }: Props) {
  const [loading, setLoading] = useState(true);
  const [welcome, setWelcome] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getSiteAskConfig(siteId).then((res) => {
      if (!alive) return;
      if (res.success && res.data) {
        setWelcome(res.data.welcome ?? null);
        setQuestions(res.data.suggestedQuestions ?? []);
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [siteId]);

  if (loading) return <MapSectionLoader text="正在准备…" />;

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
      <AskPanel
        source={{ mode: 'site', siteId }}
        title={title}
        welcome={welcome}
        openingQuestions={questions}
        // 站内路径本来就要求登录，不存在匿名场景
        allowAnonymous
        isMobile={false}
        onClose={() => { /* 面板由父级顶栏按钮控制开合，这里不自行关闭 */ }}
        embedded
      />
    </div>
  );
}
