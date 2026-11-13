// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { dockReportWidget } from '../reportWidgetDock';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function slot(parent: HTMLElement = document.body) {
  const node = document.createElement('div'); node.setAttribute('data-report-widget-slot', ''); parent.append(node); return node;
}
function widget() {
  const node = document.createElement('div'); node.id = 'cds-widget';
  node.setAttribute('style', 'position:fixed;left:12px;bottom:12px'); node.setAttribute('data-cds-placement', 'bottom-left');
  document.body.append(node); return node;
}
afterEach(() => document.body.replaceChildren());

describe('报告宿主停靠旧预览widget', () => {
  it('保留同一节点，退出时还原原锚点、内联样式和位置属性', () => {
    const before = document.createElement('span'); document.body.append(before);
    const node = widget(), originalStyle = node.getAttribute('style');
    const after = document.createElement('span'); document.body.append(after);
    const host = slot(), stop = dockReportWidget(host);
    expect(host.firstElementChild).toBe(node);
    node.style.left = '99px'; node.setAttribute('data-cds-placement', 'top-right');
    stop();
    expect(before.nextSibling).toBe(node); expect(node.nextSibling).toBe(after);
    expect(node.getAttribute('style')).toBe(originalStyle);
    expect(node.getAttribute('data-cds-placement')).toBe('bottom-left');
  });

  it('晚到的widget也进入宿主，关闭后退出不会复活', async () => {
    const host = slot(), stop = dockReportWidget(host), node = widget();
    await settle(); expect(host.firstElementChild).toBe(node);
    node.remove(); await settle(); stop();
    expect(document.getElementById('cds-widget')).toBeNull();
    expect(document.body.textContent).toBe('');
  });

  it('首个已连接slot唯一接管，首槽退出后下一槽接管并能还原', async () => {
    const first = slot(), second = slot(), node = widget();
    const stopFirst = dockReportWidget(first), stopSecond = dockReportWidget(second);
    await settle(); expect(node.parentNode).toBe(first); expect(second.childNodes.length).toBe(0);
    first.remove(); stopFirst(); await settle();
    expect(node.parentNode).toBe(second);
    second.remove(); stopSecond();
    expect(node.parentNode).toBe(document.body);
    expect(node.getAttribute('data-cds-placement')).toBe('bottom-left');
  });

  it('嵌套报告同时卸载也由首槽还原，不把widget留在脱离文档的子树', async () => {
    const first = slot(), nested = slot(first), node = widget();
    const stopFirst = dockReportWidget(first), stopNested = dockReportWidget(nested);
    await settle(); expect(node.parentNode).toBe(first);
    first.remove(); stopFirst(); stopNested();
    expect(node.isConnected).toBe(true); expect(node.parentNode).toBe(document.body);
  });

  it('无widget时不创建替代节点或停靠记录', async () => {
    const host = slot(), stop = dockReportWidget(host); await settle(); stop();
    expect(host.childNodes.length).toBe(0); expect(document.getElementById('cds-widget')).toBeNull();
    expect(Array.from(document.body.childNodes).some(node => node.nodeType === Node.COMMENT_NODE)).toBe(false);
  });
});
