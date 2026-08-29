import { useCallback, useState } from 'react';
import { ArrowRight, ExternalLink, Server, ShieldAlert } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { createLlmGatewaySsoTicket } from '@/services';
import { resolveLlmGatewaySso } from '@/lib/llmGatewaySso';
import { toast } from '@/lib/toast';

/**
 * `/mds` 的墓碑页。
 *
 * 2026-08-25：模型上游、模型、模型池、AppCaller 绑定统一由 LLM Gateway 控制台维护，
 * MAP 这边的四个管理 tab（应用模型池 / 模型池 / 平台 / 中继）整套下线。
 *
 * 为什么留一个页面而不是直接删掉路由：这条路径被收藏、被文档、被历史交付消息引用了很久，
 * 直接 404 只会让人以为「功能没了」，然后去别处再配一遍——那正是这次要根治的事
 *（guided-exploration：陌生页面 3 秒内知道这是什么、下一步点哪）。
 *
 * 页面只做一件事：把人一键送进网关控制台。不再提供任何写入口——写接口在后端也已被
 * `MdsWriteRetiredFilter` 统一挡掉（prd-api），两边同时封死，避免只封一头留下绕行路径。
 */
export function ModelManageMovedPage() {
  const [opening, setOpening] = useState(false);

  const openGateway = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      const result = await createLlmGatewaySsoTicket();
      if (!result.success) {
        toast.error('模型网关暂时无法打开', result.error?.message);
        return;
      }
      // 票据签发成功仍可能没有可去的入口（预览分支名过长时平台不发布网关子域）。
      // 那与凭据无关，必须报服务端给的真实原因（no-rootless-tree：说不出就别编）。
      const resolution = resolveLlmGatewaySso(result.data.code, result.data.console);
      if (!resolution.ok) {
        toast.error('模型网关暂时无法打开', resolution.message);
        return;
      }
      window.location.assign(resolution.href);
    } finally {
      setOpening(false);
    }
  }, [opening]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* 内容只有两块卡，撑不满一屏。与其把空白全甩在下半屏（content-fills-canvas 反面），
          不如让内容块在可用高度里居中——短内容时上下留白对称，内容长了 `m-auto` 自动失效退回正常滚动。 */}
      <div className="flex-1 min-h-0 overflow-y-auto flex" style={{ overscrollBehavior: 'contain' }}>
        <div className="m-auto w-full max-w-[860px] px-4 py-8 flex flex-col gap-4">
          <GlassCard padding="lg">
            <div className="flex flex-col gap-5">
              <div className="flex items-center gap-2">
                <span
                  className="inline-flex h-9 w-9 items-center justify-center rounded-[12px]"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-primary-solid)' }}
                >
                  <Server size={18} />
                </span>
                <span
                  className="text-[11px] font-mono uppercase tracking-[0.14em]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  模型管理
                </span>
              </div>

              <div className="flex flex-col gap-2">
                <h1 className="text-[26px] font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
                  模型管理已经搬到「模型网关」
                </h1>
                <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  上游 Provider、模型、模型池、AppCaller 绑定，现在全部在 LLM Gateway 控制台维护。
                  这里原来的四个管理 tab 已经下线，MAP 不再是模型配置的入口。
                </p>
              </div>

              <div>
                <Button variant="primary" onClick={() => void openGateway()} disabled={opening}>
                  {opening ? <MapSpinner size={16} /> : <ExternalLink size={16} />}
                  打开模型网关控制台
                  {!opening && <ArrowRight size={16} />}
                </Button>
              </div>
            </div>
          </GlassCard>

          <GlassCard padding="lg">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <ShieldAlert size={16} style={{ color: 'var(--text-muted)' }} />
                <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  为什么必须去那边配
                </span>
              </div>
              <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                网关的配置是权威来源，MAP 侧的旧集合只在没迁移完时兜底。
                在 MAP 这边配出来的上游，网关控制台会显示成「待导入」，
                要再点一次「导入到平台」才真正生效——等于同一件事做两遍，还容易只做一半。
              </p>
              <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                所以 MAP 的模型管理写接口已经整体停用：`api/mds` 下的新增、修改、删除一律返回
                410，并在响应里告诉调用方去网关控制台。读接口保留，供实验台等页面挑模型用。
              </p>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

export default ModelManageMovedPage;
