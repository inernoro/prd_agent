import { useMemo } from 'react';

export type WizardLoaderProps = {
  className?: string;
  label?: string;
  /**
   * label 展示模式：
   * - inline：在动画右侧以“输入框同款基线”展示（默认）
   * - below：在动画下方左侧展示（用于消息气泡内，占据下方空白区）
   * - overlay：覆盖在动画下方（旧行为）
   */
  labelMode?: 'inline' | 'below' | 'overlay';
  /** 控制整体大小（px） */
  size?: number;
};

/**
 * 轻量“巫师加载”动画（参考 thirdparty/ref/加载巫师.html）
 * - 去掉噪点/base64，避免污染样式与体积膨胀
 * - 样式完全 scoped 到 .wizardLoader_*，方便随时删除
 */
export default function WizardLoader({
  className,
  label,
  labelMode = 'inline',
  size = 120,
}: WizardLoaderProps) {
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const styleText = useMemo(() => {
    // 注意：这里用 class 前缀隔离，避免影响其它组件
    return `
.wizardLoader_root{display:flex;align-items:center;gap:12px;}
.wizardLoader_rootCol{flex-direction:column;align-items:flex-start;justify-content:space-between;gap:0;}
.wizardLoader_row{display:flex;align-items:center;gap:12px;}
.wizardLoader_labelInline{display:flex;align-items:center;height:36px;padding:0 12px;border:none;border-radius:12px;background:rgba(148,163,184,.10);}
.wizardLoader_labelText{font-size:14px;line-height:20px;color:var(--tw-prose-body,#6b7280);}
.wizardLoader_scene{position:relative;display:flex;align-items:center;justify-content:center;}
.wizardLoader_wizard{position:relative;width:95px;height:120px;transform-origin:center;}
.wizardLoader_body{position:absolute;bottom:0;left:34px;height:50px;width:30px;background:#3f64ce;border-radius:10px;}
.wizardLoader_body:after{content:"";position:absolute;bottom:0;left:10px;height:50px;width:30px;background:#3f64ce;transform:skewX(14deg);border-radius:10px;}
.wizardLoader_rightArm{position:absolute;bottom:37px;left:55px;height:22px;width:45px;background:#3f64ce;border-radius:11px;transform-origin:8px 11px;}
.wizardLoader_rightHand{position:absolute;right:4px;bottom:4px;width:15px;height:15px;border-radius:999px;background:#f1c5b4;transform-origin:center;}
.wizardLoader_rightHand:after{content:"";position:absolute;right:0;top:-4px;width:8px;height:15px;border-radius:8px;background:#f1c5b4;transform:translateY(8px);}
.wizardLoader_leftArm{position:absolute;bottom:37px;left:13px;height:22px;width:35px;background:#3f64ce;border-bottom-left-radius:8px;transform-origin:30px 13px;}
.wizardLoader_leftHand{position:absolute;left:-9px;top:0;width:9px;height:15px;border-top-left-radius:35px;border-bottom-left-radius:35px;background:#f1c5b4;}
.wizardLoader_leftHand:after{content:"";position:absolute;right:0;top:0;width:15px;height:8px;border-radius:20px;background:#f1c5b4;transform-origin:right bottom;}
.wizardLoader_head{position:absolute;top:0;left:7px;width:80px;height:105px;transform-origin:center;}
.wizardLoader_beard{position:absolute;bottom:0;left:19px;height:53px;width:40px;border-bottom-right-radius:55%;background:#ffffff;}
.wizardLoader_beard:after{content:"";position:absolute;top:8px;left:-5px;width:20px;height:10px;border-radius:10px;background:#ffffff;}
.wizardLoader_face{position:absolute;bottom:38px;left:19px;height:15px;width:30px;background:#f1c5b4;}
.wizardLoader_face:before{content:"";position:absolute;top:0;left:20px;width:10px;height:20px;border-bottom-right-radius:10px;border-bottom-left-radius:10px;background:#f1c5b4;}
.wizardLoader_face:after{content:"";position:absolute;top:8px;left:-5px;width:25px;height:10px;border-radius:10px;border-bottom-right-radius:0;background:#ffffff;}
.wizardLoader_adds{position:absolute;top:0;left:-5px;width:20px;height:10px;border-radius:10px;background:#f1c5b4;}
.wizardLoader_adds:after{content:"";position:absolute;top:2px;left:40px;width:8px;height:10px;border-bottom-right-radius:10px;border-top-right-radius:10px;background:#f1c5b4;}
.wizardLoader_hat{position:absolute;bottom:53px;left:0;width:80px;height:10px;border-radius:10px;background:#3f64ce;}
.wizardLoader_hat:before{content:"";position:absolute;top:-35px;left:50%;transform:translateX(-50%);width:0;height:0;border-style:solid;border-width:0 17px 35px 25px;border-color:transparent transparent #3f64ce transparent;}
.wizardLoader_hat:after{content:"";position:absolute;top:0;left:0;width:80px;height:10px;background:#3f64ce;border-radius:10px;}
.wizardLoader_objects{position:relative;width:90px;height:120px;margin-right:6px;}
.wizardLoader_circle{position:absolute;bottom:5px;left:0;width:45px;height:45px;border-radius:999px;border:2px solid rgba(137,190,179,.55);}
.wizardLoader_square{position:absolute;bottom:-5px;left:18px;width:16px;height:16px;background:rgba(154,179,245,.9);}
.wizardLoader_triangle{position:absolute;bottom:28px;left:40px;width:0;height:0;border-style:solid;border-width:0 9px 16px 9px;border-color:transparent transparent rgba(197,97,131,.85) transparent;}
.wizardLoader_label{font-size:12px;line-height:16px;color:var(--tw-prose-body,#6b7280);}
.wizardLoader_labelInScene{position:absolute;left:6px;bottom:-14px;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;}

@keyframes wizardLoader_head{0%{transform:rotate(-3deg)}10%{transform:translateX(6px) rotate(7deg)}50%{transform:translateX(0) rotate(0)}56%{transform:rotate(-3deg)}}
@keyframes wizardLoader_rightArm{0%{transform:rotate(70deg)}10%{transform:rotate(8deg)}15%{transform:rotate(20deg)}20%{transform:rotate(10deg)}25%{transform:rotate(26deg)}30%{transform:rotate(10deg)}35%{transform:rotate(28deg)}40%{transform:rotate(9deg)}45%{transform:rotate(28deg)}50%{transform:rotate(8deg)}58%{transform:rotate(74deg)}62%{transform:rotate(70deg)}}
@keyframes wizardLoader_leftArm{0%{transform:rotate(-70deg)}10%{transform:rotate(6deg)}15%{transform:rotate(-18deg)}20%{transform:rotate(5deg)}25%{transform:rotate(-18deg)}30%{transform:rotate(5deg)}35%{transform:rotate(-17deg)}40%{transform:rotate(5deg)}45%{transform:rotate(-18deg)}50%{transform:rotate(6deg)}58%{transform:rotate(-74deg)}62%{transform:rotate(-70deg)}}
@keyframes wizardLoader_objs{0%{transform:translateY(0) rotate(0)}10%{transform:translateY(-14px) rotate(10deg)}55%{transform:translateY(-14px) rotate(-350deg)}63%{transform:translateY(0) rotate(-360deg)}}

.wizardLoader_animate .wizardLoader_head{animation:wizardLoader_head 10s ease-in-out infinite;}
.wizardLoader_animate .wizardLoader_rightArm{animation:wizardLoader_rightArm 10s ease-in-out infinite;}
.wizardLoader_animate .wizardLoader_leftArm{animation:wizardLoader_leftArm 10s ease-in-out infinite;}
.wizardLoader_animate .wizardLoader_objects{animation:wizardLoader_objs 10s ease-in-out infinite;transform-origin:center;}
`;
  }, []);

  const scale = Math.max(72, Math.min(220, Number(size) || 120)) / 120;
  // below 模式：需要给一个稳定的最小高度，让“动画在上、文案贴底”成立
  // 经验值：动画高度(≈120*scale) + label(36) + 28（空白/缓冲）
  const belowMinHeightPx = Math.round(120 * scale + 64);
  const rootClass = `wizardLoader_root ${labelMode === 'below' ? 'wizardLoader_rootCol' : ''} ${reduceMotion ? '' : 'wizardLoader_animate'} ${className || ''}`.trim();

  return (
    <div
      className={rootClass}
      style={labelMode === 'below' ? { minHeight: `${belowMinHeightPx}px` } : undefined}
      aria-label={label || '处理中'}
      title={label || '处理中'}
    >
      <style>{styleText}</style>
      <div className={labelMode === 'below' ? 'wizardLoader_row' : ''}>
        <div className="wizardLoader_scene" style={{ transform: `scale(${scale})` }}>
          <div className="wizardLoader_objects" aria-hidden="true">
            <div className="wizardLoader_circle" />
            <div className="wizardLoader_square" />
            <div className="wizardLoader_triangle" />
          </div>
          <div className="wizardLoader_wizard" aria-hidden="true">
            <div className="wizardLoader_body" />
            <div className="wizardLoader_rightArm">
              <div className="wizardLoader_rightHand" />
            </div>
            <div className="wizardLoader_leftArm">
              <div className="wizardLoader_leftHand" />
            </div>
            <div className="wizardLoader_head">
              <div className="wizardLoader_beard" />
              <div className="wizardLoader_face">
                <div className="wizardLoader_adds" />
              </div>
              <div className="wizardLoader_hat" />
            </div>
          </div>
          {label && labelMode === 'overlay' ? (
            <div className="wizardLoader_label wizardLoader_labelInScene">{label}</div>
          ) : null}
        </div>
        {label && labelMode === 'inline' ? (
          <div className="wizardLoader_labelInline">
            <span className="wizardLoader_labelText">{label}</span>
          </div>
        ) : null}
      </div>
      {label && labelMode === 'below' ? (
        <div className="wizardLoader_labelInline">
          <span className="wizardLoader_labelText">{label}</span>
        </div>
      ) : null}
    </div>
  );
}


