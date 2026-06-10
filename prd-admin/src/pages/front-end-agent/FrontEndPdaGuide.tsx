import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, ChevronRight, Clipboard, ExternalLink, PackageCheck, Search, Smartphone, Terminal, X } from 'lucide-react';
import { toast } from '@/lib/toast';

interface PdaGuideSection {
  key: string;
  title: string;
  summary: string;
  items: string[];
}

const PDA_LINKS = [
  { label: 'GitHub 仓库', url: 'https://github.com/MiDouTech/uniapp-pda.git' },
  { label: 'Jenkins 构建', url: 'http://192.168.5.140/job/uniapp-pda/' },
  { label: 'Coding 构建', url: 'https://miduoyanfa.coding.net/p/bigdataengine/ci/job?id=6517671' },
  { label: 'APK 产物仓库', url: 'https://e.coding.net/miduoyanfa/bigdataengine/pda-build.git' },
];

const PDA_GUIDE_SECTIONS: PdaGuideSection[] = [
  {
    key: 'overview',
    title: '项目说明',
    summary: 'uniapp-pda 是基于 UniApp + Vue3 的 Android PDA 业务应用，覆盖扫码入库、出货、退货、调仓、关联和同步等仓配场景。',
    items: [
      '终端形态：Android PDA，优先 App 真机运行。',
      '技术框架：UniApp 3 + Vue 3 + Vite，UI 使用 uview-plus。',
      '网络请求：统一走 src/utils/request.js，自动附加 access_token 与 sign。',
      '本地数据：启用 SQLite，关键业务数据按品牌商目录和登录帐号隔离。',
      '核心目录：src/api、src/components、src/config、src/hooks、src/pages、src/sql、src/utils。',
    ],
  },
  {
    key: 'develop',
    title: '开发调试',
    summary: 'PDA 改动以 Android 真机基座为准，H5 只适合临时调样式，最终必须回真机验收扫码和存储链路。',
    items: [
      'Node.js 建议 >= 22，依赖安装使用 npm install。',
      '常用命令：npm run dev:h5、npm run build:plus、npm run lint、npm run lint:fix、npm run format。',
      'HBuilderX 打开目录：g:\\project\\pda\\uniapp-pda。',
      '真机运行：运行 -> 运行到手机或模拟器 -> Android App 基座。',
      '接口排查可用 Fiddler：PDA 与电脑同局域网，PDA WiFi 代理指向电脑 IP 与 8888 端口。',
    ],
  },
  {
    key: 'business',
    title: '操作手册要点',
    summary: '现场操作优先关注登录、激活、扫码、在线/离线、同步和本地数据库恢复这些高频问题。',
    items: [
      '激活：生产环境登录前会校验许可，激活页为 pages/login/activation。',
      '激活码：每个激活码仅可成功用于一次有效激活，换机需重新申请。',
      '灰度标识：登录页底部版本号快速点击 8 次进入灰度标识设置页。',
      '导出 DB：同样从灰度标识设置页进入，点击“导出 DB”后再从导出目录拷贝库文件。',
      '在线模式：扫码一般走服务端校验；离线模式：扫码结果优先落本地数据库，后续集中上传。',
      '低配 WebView：少用复杂阴影、滤镜、长动画和 gap；高频按钮弱化按下动画。',
    ],
  },
  {
    key: 'release',
    title: '构建与发布',
    summary: 'WGT 热更新优先走 Jenkins；APK 完整包走本地云打包后覆盖 pda-build 仓库，再触发 Coding 构建。',
    items: [
      '默认仓库：https://github.com/MiDouTech/uniapp-pda.git，默认构建分支 master。',
      'Jenkins：打开 uniapp-pda 任务，点击 Build with Parameters。',
      '参数 is_prod_env：不勾选为测试环境，勾选为线上环境。',
      '参数 version_name：展示版本号，每次发布一般递增。',
      '参数 update_desc：PDA 端更新时展示给用户的更新说明。',
      'WGT 包命名：pda.wgt；APK 包命名：pda.apk。',
      'APK 手动构建：运行本地打包脚本，产物从 dist/release/apk 取出并重命名为 pda.apk。',
      '发布前检查：环境、versionName、versionCode、AppID、产物命名、真机业务回归。',
    ],
  },
  {
    key: 'troubleshooting',
    title: '排障与 AI 提示词',
    summary: '真机问题先结构化复现路径，再把日志、机型、版本和在线/离线状态交给 AI 辅助缩小范围。',
    items: [
      '问题描述必须包含：机型/WebView、App 版本、在线或离线、菜单路径、操作步骤、期望结果、实际结果。',
      '日志来源：HBuilderX 真机运行控制台、项目关键路径日志、接口状态码和响应片段。',
      '登录异常：先确认 token 是否有效、是否触发登录过期、激活许可是否失效。',
      '设备识别不到：重插 USB、确认传输模式、重新授权 USB 调试、重启 HBuilderX。',
      '弱网/大文件上传：默认超时 60 秒，长耗时业务应按单次请求传 options.timeout。',
      '静态资源：新增图片先压缩，再在目标低配真机验证内存和滑动流畅度。',
    ],
  },
];

const RELEASE_CHECKLIST = `PDA 发布检查清单
1. 代码已合并并推送到 master。
2. 确认发布环境：测试环境 is_prod_env 不勾选；线上环境 is_prod_env 勾选。
3. 填写 version_name，确保高于设备当前版本。
4. 填写 update_desc，说明本次变更且不使用 HTML 标签。
5. 触发 Jenkins： http://192.168.5.140/job/uniapp-pda/
6. 构建成功后，在目标环境 PDA 真机检查是否收到更新提示。
7. 回归登录、扫码、同步、出货、退货、在线/离线关键链路。
8. 若为 APK，确认产物命名 pda.apk 并同步到 pda-build 仓库 app 目录。`;

const AI_BUG_PROMPT = `请帮我定位 uniapp-pda 真机问题。

机型/WebView：
App 版本：
运行环境：测试 / 线上
模式：在线 / 离线
菜单路径：
操作步骤：
1.
2.
3.

期望结果：
实际结果：
控制台/接口日志：
已尝试的处理：

请输出：
1. 最可能原因排序
2. 需要查看的文件或函数
3. 建议增加的验证日志
4. 最小修复方案
5. 真机回归步骤`;

function sectionText(section: PdaGuideSection): string {
  return `${section.title}\n${section.summary}\n${section.items.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
}

export function FrontEndPdaRailCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="fea-rail-card w-full text-left rounded-2xl border border-amber-400/25 bg-gradient-to-br from-amber-500/[0.16] to-orange-500/[0.05] p-4 hover:border-amber-300/40 hover:shadow-[0_8px_32px_rgba(245,158,11,0.14)] relative overflow-hidden"
    >
      <div
        className="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-amber-400/10 fea-hero-orb-alt pointer-events-none"
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl border border-amber-400/35 bg-amber-500/20 flex items-center justify-center shrink-0">
            <Smartphone className="w-4 h-4 text-amber-100" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white">PDA 项目手册</h3>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium border border-amber-300/30 bg-amber-400/15 text-amber-100/90">
                重点
              </span>
            </div>
            <p className="text-[11px] text-amber-100/55 mt-0.5">uniapp-pda · 真机调试 · 发布排障</p>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-amber-200/50 shrink-0 mt-1" />
      </div>
      <div className="relative mt-3 grid grid-cols-2 gap-1.5">
        {PDA_LINKS.slice(0, 2).map((link) => (
          <span key={link.url} className="text-[10px] text-white/45 truncate">
            {link.label}
          </span>
        ))}
      </div>
      <p className="relative mt-2 text-[10px] text-amber-200/50">点击打开完整手册、快捷链接与 AI 排障模板</p>
    </button>
  );
}

export function FrontEndPdaGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');

  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PDA_GUIDE_SECTIONS;
    return PDA_GUIDE_SECTIONS.filter((section) =>
      sectionText(section).toLowerCase().includes(q)
    );
  }, [query]);

  const copyText = useCallback(async (text: string, message: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const modal = (
    <div
      className="fea-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/65 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="PDA 项目手册"
        className="fea-modal-panel w-full max-w-5xl rounded-2xl border border-white/10 bg-[#0b0d12] shadow-2xl flex flex-col"
        style={{ height: '90vh', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl border border-amber-400/25 bg-amber-500/10 flex items-center justify-center">
              <Smartphone className="w-4 h-4 text-amber-200" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white">PDA 项目手册</h2>
              <p className="text-[11px] text-white/45">项目说明、开发调试、现场操作、构建发布和 AI 排障模板</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="fea-btn h-8 w-8 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 inline-flex items-center justify-center text-white/60"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="shrink-0 px-5 py-3 border-b border-white/10 flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜：发布 / 激活 / 导出 DB / 离线 / WebView"
              className="w-full h-9 rounded-xl border border-white/10 bg-black/20 pl-8 pr-3 text-xs text-white placeholder:text-white/25 outline-none focus:border-amber-300/35"
            />
          </div>
          <button
            type="button"
            onClick={() => copyText(RELEASE_CHECKLIST, '已复制 PDA 发布检查清单')}
            className="fea-btn h-9 shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-white/65 hover:bg-white/10 inline-flex items-center gap-1.5"
          >
            <PackageCheck className="w-3.5 h-3.5" />
            复制发布清单
          </button>
          <button
            type="button"
            onClick={() => copyText(AI_BUG_PROMPT, '已复制 PDA 排障提示词')}
            className="fea-btn h-9 shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-white/65 hover:bg-white/10 inline-flex items-center gap-1.5"
          >
            <Terminal className="w-3.5 h-3.5" />
            复制排障提示词
          </button>
        </div>

        <div
          className="flex-1 p-5 space-y-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
            {PDA_LINKS.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="fea-link rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-xs text-sky-200/85 hover:bg-white/[0.06] inline-flex items-center justify-between gap-2"
              >
                <span className="truncate">{link.label}</span>
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              </a>
            ))}
          </div>

          {filteredSections.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-black/15 px-4 py-5 text-sm text-white/45">
              没有匹配的 PDA 手册内容。换“发布、激活、离线、扫码、WebView、导出 DB”等关键词试试。
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {filteredSections.map((section) => (
                <article key={section.key} className="rounded-xl border border-white/10 bg-black/15 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-white flex items-center gap-2">
                        <BookOpen className="w-3.5 h-3.5 text-amber-200/80" />
                        {section.title}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-white/50">{section.summary}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyText(sectionText(section), `已复制 ${section.title}`)}
                      className="fea-btn h-8 shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11px] text-white/65 hover:bg-white/10 inline-flex items-center gap-1.5"
                    >
                      <Clipboard className="w-3.5 h-3.5" />
                      复制
                    </button>
                  </div>
                  <ul className="mt-3 space-y-1.5 text-[11px] leading-5 text-white/55">
                    {section.items.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="mt-2 h-1 w-1 rounded-full bg-amber-300/60 shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
