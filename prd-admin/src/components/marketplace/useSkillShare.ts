import { useState, useCallback, useRef } from 'react';
import { createMarketplaceSkillShare } from '@/services';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';

/** 生成技能公开分享链接并复制到剪贴板。卡片与详情弹窗共用。 */
export function useSkillShare() {
  const [sharing, setSharing] = useState(false);
  // 同步锁：state 更新到下次渲染才生效，两次极速点击会都读到 sharing=false
  // 而双双发请求。用 ref 做同步幂等闸，并让 callback 身份稳定（空依赖）。
  const sharingRef = useRef(false);

  const shareSkill = useCallback(async (id: string) => {
    if (sharingRef.current) return;
    sharingRef.current = true;
    setSharing(true);
    try {
      const res = await createMarketplaceSkillShare({ id });
      if (!res.success || !res.data?.shareUrl) {
        toast.error(res.error?.message || '生成分享链接失败');
        return;
      }
      const fullUrl = `${window.location.origin}${res.data.shareUrl}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(fullUrl);
        copied = true;
      } catch {
        copied = false;
      }
      if (copied) {
        toast.success('分享链接已复制到剪贴板');
      } else {
        await systemDialog.alert({
          title: '分享链接',
          message: `复制下面的链接分享给他人（无需登录即可查看）：\n\n${fullUrl}`,
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成分享链接失败');
    } finally {
      sharingRef.current = false;
      setSharing(false);
    }
  }, []);

  return { sharing, shareSkill };
}
