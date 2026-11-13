import { useEffect, useRef } from 'react';
import { dockReportWidget, REPORT_WIDGET_DOCK_STYLE } from '@/lib/reportWidgetDock';

/** 放在报告根层，避免固定诊断面板被卡片的backdrop/filter/transform限制。 */
export function ReportWidgetDock() {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (slot.current) return dockReportWidget(slot.current);
  }, []);
  return <><style>{REPORT_WIDGET_DOCK_STYLE}</style><div ref={slot} data-report-widget-slot="" className="self-end" /></>;
}
