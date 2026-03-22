import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ChevronRight, Lightbulb, AlertTriangle, HelpCircle,
  Play, type LucideIcon,
  FileText, Palette, PenTool, Bug, Video, FileBarChart, Swords, Workflow, Zap,
} from 'lucide-react';
import { tutorialContents, type TutorialContent } from './tutorialData';

// ── Reusable section components ──

/** Table-of-contents sidebar item */
function TocItem({ label, active, onClick }: { id: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full text-left px-3 py-1.5 rounded-lg text-sm transition-all duration-200"
      style={{
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        background: active ? 'var(--bg-hover, rgba(0,0,0,0.06))' : 'transparent',
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}

/** Numbered step block */
function StepBlock({ index, title, content, accentColor }: { index: number; title: string; content: string; accentColor: string }) {
  return (
    <div className="flex gap-4 mb-5">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0 mt-0.5"
        style={{ background: accentColor }}
      >
        {index}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{title}</div>
        <div className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{content}</div>
      </div>
    </div>
  );
}

/** Tip / Warning / Info callout box */
function Callout({ type, children }: { type: 'tip' | 'warning' | 'info'; children: React.ReactNode }) {
  const config = {
    tip: { icon: Lightbulb, bg: '#10B98115', border: '#10B98130', iconColor: '#10B981', label: '提示' },
    warning: { icon: AlertTriangle, bg: '#F59E0B15', border: '#F59E0B30', iconColor: '#F59E0B', label: '注意' },
    info: { icon: HelpCircle, bg: '#3B82F615', border: '#3B82F630', iconColor: '#3B82F6', label: '说明' },
  }[type];
  const Icon = config.icon;

  return (
    <div
      className="flex gap-3 px-4 py-3 rounded-xl mb-5"
      style={{ background: config.bg, border: `1px solid ${config.border}` }}
    >
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: config.iconColor }} />
      <div className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{children}</div>
    </div>
  );
}

/** Section heading with anchor */
function SectionHeading({ id, title, accentColor }: { id: string; title: string; accentColor: string }) {
  return (
    <h2
      id={id}
      className="text-lg font-bold mb-5 pb-3 scroll-mt-6"
      style={{ color: 'var(--text-primary)', borderBottom: `2px solid ${accentColor}30` }}
    >
      {title}
    </h2>
  );
}

/** Sub-section heading */
function SubHeading({ title }: { title: string }) {
  return (
    <h3 className="text-base font-semibold mb-3 mt-6" style={{ color: 'var(--text-primary)' }}>
      {title}
    </h3>
  );
}

/** Feature detail block */
function FeatureBlock({ title, description }: { title: string; description: string }) {
  return (
    <div
      className="px-4 py-3 rounded-xl mb-3"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
    >
      <div className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{title}</div>
      <div className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{description}</div>
    </div>
  );
}

/** FAQ item (collapsible) */
function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded-xl mb-2 overflow-hidden"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{question}</span>
        <ChevronRight
          className="w-4 h-4 flex-shrink-0 transition-transform duration-200"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none' }}
        />
      </button>
      {open && (
        <div className="px-4 pb-3">
          <div className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{answer}</div>
        </div>
      )}
    </div>
  );
}

// Icon map
const iconMap: Record<string, LucideIcon> = {
  'prd-agent': FileText,
  'visual-agent': Palette,
  'literary-agent': PenTool,
  'defect-agent': Bug,
  'video-agent': Video,
  'report-agent': FileBarChart,
  'arena': Swords,
  'workflow-agent': Workflow,
  'shortcuts-agent': Zap,
};

// ── Main page ──

export default function TutorialDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState('');

  const tutorial: TutorialContent | undefined = id ? tutorialContents[id] : undefined;

  // Track scroll position for ToC highlight
  useEffect(() => {
    if (!tutorial) return;
    const sectionIds = tutorial.sections.map(s => s.id);
    const handleScroll = () => {
      let current = sectionIds[0] || '';
      for (const sid of sectionIds) {
        const el = document.getElementById(sid);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= 120) current = sid;
        }
      }
      setActiveSection(current);
    };

    const container = document.getElementById('tutorial-scroll-container');
    if (container) {
      container.addEventListener('scroll', handleScroll, { passive: true });
      handleScroll();
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [tutorial]);

  const scrollToSection = (sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Navigation between tutorials
  const tutorialIds = Object.keys(tutorialContents);
  const currentIndex = id ? tutorialIds.indexOf(id) : -1;
  const prevTutorial = currentIndex > 0 ? tutorialContents[tutorialIds[currentIndex - 1]] : null;
  const nextTutorial = currentIndex < tutorialIds.length - 1 ? tutorialContents[tutorialIds[currentIndex + 1]] : null;

  if (!tutorial || !id) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <div className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>教程未找到</div>
          <button
            type="button"
            onClick={() => navigate('/tutorials')}
            className="text-sm px-4 py-2 rounded-lg"
            style={{ color: 'var(--text-link, #3B82F6)' }}
          >
            返回教程列表
          </button>
        </div>
      </div>
    );
  }

  const Icon = iconMap[id] || FileText;

  return (
    <div id="tutorial-scroll-container" className="h-full overflow-y-auto" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Breadcrumb + back */}
        <div className="flex items-center gap-2 mb-6">
          <button
            type="button"
            onClick={() => navigate('/tutorials')}
            className="flex items-center gap-1.5 text-sm transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <ArrowLeft className="w-4 h-4" />
            使用教程
          </button>
          <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{tutorial.title}</span>
        </div>

        {/* Hero header */}
        <div className="mb-8 pb-6" style={{ borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex items-start gap-4">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
              style={{ background: `linear-gradient(135deg, ${tutorial.accentColor}, ${tutorial.accentColorEnd})` }}
            >
              <Icon className="w-7 h-7 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{tutorial.title}</h1>
              <p className="text-base mb-3" style={{ color: 'var(--text-muted)' }}>{tutorial.subtitle}</p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{tutorial.overview}</p>
            </div>
          </div>

          {/* Quick action - try it */}
          {tutorial.tryPath && (
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => navigate(tutorial.tryPath!)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ background: `linear-gradient(135deg, ${tutorial.accentColor}, ${tutorial.accentColorEnd})` }}
              >
                <Play className="w-4 h-4" />
                立即体验
              </button>
            </div>
          )}
        </div>

        {/* Layout: sidebar ToC + main content */}
        <div className="flex gap-8">
          {/* Sidebar ToC - sticky */}
          <nav className="hidden lg:block w-56 flex-shrink-0">
            <div className="sticky top-6 space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
                目录
              </div>
              {tutorial.sections.map((section) => (
                <TocItem
                  key={section.id}
                  id={section.id}
                  label={section.title}
                  active={activeSection === section.id}
                  onClick={() => scrollToSection(section.id)}
                />
              ))}
            </div>
          </nav>

          {/* Main tutorial content */}
          <main className="flex-1 min-w-0">
            {tutorial.sections.map((section) => (
              <section key={section.id} className="mb-12">
                <SectionHeading id={section.id} title={section.title} accentColor={tutorial.accentColor} />

                {section.intro && (
                  <p className="text-sm leading-relaxed mb-5 whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{section.intro}</p>
                )}

                {/* Steps */}
                {section.steps && section.steps.length > 0 && (
                  <div className="mb-5">
                    {section.steps.map((step, i) => (
                      <StepBlock key={i} index={i + 1} title={step.title} content={step.content} accentColor={tutorial.accentColor} />
                    ))}
                  </div>
                )}

                {/* Sub-sections */}
                {section.subsections?.map((sub, i) => (
                  <div key={i}>
                    <SubHeading title={sub.title} />
                    {sub.content && (
                      <p className="text-sm leading-relaxed mb-4 whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{sub.content}</p>
                    )}
                    {sub.steps?.map((step, j) => (
                      <StepBlock key={j} index={j + 1} title={step.title} content={step.content} accentColor={tutorial.accentColor} />
                    ))}
                    {sub.features?.map((f, j) => (
                      <FeatureBlock key={j} title={f.title} description={f.description} />
                    ))}
                  </div>
                ))}

                {/* Features */}
                {section.features && section.features.length > 0 && (
                  <div>
                    {section.features.map((f, i) => (
                      <FeatureBlock key={i} title={f.title} description={f.description} />
                    ))}
                  </div>
                )}

                {/* Callout tips */}
                {section.tips?.map((tip, i) => (
                  <Callout key={i} type={tip.type}>{tip.content}</Callout>
                ))}

                {/* FAQ */}
                {section.faq && section.faq.length > 0 && (
                  <div>
                    {section.faq.map((item, i) => (
                      <FaqItem key={i} question={item.q} answer={item.a} />
                    ))}
                  </div>
                )}
              </section>
            ))}

            {/* Prev / Next navigation */}
            <div
              className="flex items-stretch gap-4 py-6 mt-8"
              style={{ borderTop: '1px solid var(--border-default)' }}
            >
              {prevTutorial ? (
                <button
                  type="button"
                  onClick={() => navigate(`/tutorials/${tutorialIds[currentIndex - 1]}`)}
                  className="flex-1 flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-hover, var(--border-default))'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
                >
                  <ArrowLeft className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>上一篇</div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{prevTutorial.title}</div>
                  </div>
                </button>
              ) : <div className="flex-1" />}
              {nextTutorial ? (
                <button
                  type="button"
                  onClick={() => navigate(`/tutorials/${tutorialIds[currentIndex + 1]}`)}
                  className="flex-1 flex items-center justify-end gap-3 px-4 py-3 rounded-xl text-right transition-colors"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-hover, var(--border-default))'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
                >
                  <div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>下一篇</div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{nextTutorial.title}</div>
                  </div>
                  <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                </button>
              ) : <div className="flex-1" />}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
