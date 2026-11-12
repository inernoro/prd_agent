import { ReportInputType, type ReportTemplateSection, type WeeklyReportItem } from '@/services/contracts/reportAgent';
import { useDataTheme } from '../hooks/useDataTheme';
import { ReportTableSectionView } from './ReportTableSectionView';
import { RichTextMarkdownContent } from './RichTextMarkdownContent';

/** Sharing consumes the same report snapshot and renderers as the author view. */
export function SharedReportSection({ section }: { section: { templateSection?: ReportTemplateSection; items: WeeklyReportItem[] } }) {
  const theme = useDataTheme();
  if (section.templateSection?.inputType === ReportInputType.Table) {
    return <ReportTableSectionView section={{ templateSection: section.templateSection, items: section.items }} isLight={theme === 'light'} />;
  }
  return <div className="space-y-2" style={{ minWidth: 0 }}>
    {section.items.map((item, index) => <div key={index}>
      {(item.issueCategoryKey || item.issueStatusKey) && <p style={{ color: 'var(--text-secondary)' }}>
        {section.templateSection?.issueCategories?.find(category => category.key === item.issueCategoryKey)?.label ?? item.issueCategoryKey}
        {' '}{section.templateSection?.issueStatuses?.find(status => status.key === item.issueStatusKey)?.label ?? item.issueStatusKey}
      </p>}
      <RichTextMarkdownContent content={item.content} imageUrls={item.imageUrls} />
    </div>)}
  </div>;
}
