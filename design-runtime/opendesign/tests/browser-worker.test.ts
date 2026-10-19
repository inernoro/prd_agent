import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runBrowserWorker } from '../src/quality/browser-worker.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(html: string): { workspaceDir: string; evidenceDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-quality-sample-'));
  roots.push(root);
  const workspaceDir = path.join(root, 'workspace');
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, 'index.html'), html);
  return { workspaceDir, evidenceDir };
}

function presentationWorkspace(html: string, targetPages: number): { workspaceDir: string; evidenceDir: string } {
  const result = workspace(html);
  fs.mkdirSync(path.join(result.workspaceDir, 'brief'));
  fs.writeFileSync(path.join(result.workspaceDir, 'brief', 'task.json'), JSON.stringify({
    presentationContract: { targetPages },
  }));
  return result;
}

describe('isolated Chromium quality measurements', () => {
  it('detects every deterministic hard-gate category from a fixed broken sample', async () => {
    const sample = workspace(`<!doctype html><html><head><style>
      body{margin:0}.wide{width:1600px}.cta{position:absolute;left:1500px;background:#111;color:#fff}
      h1{color:rgb(119,119,119);background:rgb(119,119,119)}
      table{width:900px;table-layout:fixed}td{width:20px}
      @media(max-width:500px){nav a{display:none}}
    </style></head><body>
      <nav><a href="#section">Section</a></nav>
      <main class="wide"><h1>Invisible heading</h1><a href="">Empty</a><a href="#missing">Missing</a>
        <button class="cta">Primary action</button><table><tr><td>A</td><td>B</td></tr></table>
        <section id="section">Content</section></main>
    </body></html>`);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const codes = new Set(result.measurements.flatMap((measurement) => measurement.issues.map((issue) => issue.issueCode)));

    expect(codes).toEqual(new Set([
      'horizontal_overflow',
      'main_content_clipped',
      'primary_cta_clipped',
      'empty_link',
      'broken_fragment_target',
      'mobile_navigation_unusable',
      'table_unreadable',
      'key_text_contrast_low',
    ]));
    expect(result.measurements.map((measurement) => measurement.viewport)).toEqual(['desktop', 'mobile']);
    expect(result.measurements.every((measurement) => fs.existsSync(path.join(sample.evidenceDir, path.basename(measurement.screenshotPath))))).toBe(true);
  }, 30_000);

  it('keeps desktop and mobile measurements separate for responsive failures', async () => {
    const sample = workspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.content{width:700px;max-width:none}a{color:#111}
    </style></head><body><main class="content"><h1>Responsive sample</h1><a href="#ok">Action</a><section id="ok">Ready</section></main></body></html>`);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const desktop = result.measurements.find((measurement) => measurement.viewport === 'desktop')!;
    const mobile = result.measurements.find((measurement) => measurement.viewport === 'mobile')!;

    expect(desktop.issues.map((issue) => issue.issueCode)).not.toContain('horizontal_overflow');
    expect(mobile.issues.map((issue) => issue.issueCode)).toContain('horizontal_overflow');
  }, 30_000);

  it('detects content clipped by an overflow ancestor and treats an empty fragment as an empty link', async () => {
    const sample = workspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.frame{width:220px;height:120px;overflow:hidden}
      main{width:600px;height:300px}.cta{background:#111;color:#fff;margin-left:400px}
    </style></head><body><div class="frame"><main><h1>Clipped sample</h1><a href="#">Empty anchor</a>
      <button class="cta">Primary action</button></main></div></body></html>`);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const codes = new Set(result.measurements.flatMap((measurement) => measurement.issues.map((issue) => issue.issueCode)));

    expect(codes).toContain('main_content_clipped');
    expect(codes).toContain('primary_cta_clipped');
    expect(codes).toContain('empty_link');
  }, 30_000);

  it('does not treat Reveal sections as main content for ordinary web pages', async () => {
    const sample = workspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.reveal .slides>section{display:block;min-height:600px}
    </style></head><body><div class="reveal"><div class="slides">
      <section><h1>A web page still needs an explicit main landmark</h1></section>
    </div></div></body></html>`);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const codes = result.measurements.flatMap((measurement) => measurement.issues.map((issue) => issue.issueCode));

    expect(codes).toContain('main_content_clipped');
  }, 30_000);

  it('checks every presentation slide and rejects transform-shrunk mobile text', async () => {
    const sample = presentationWorkspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.reveal .slides>section{display:none}.reveal .slides>section.active{display:block}
      @media(max-width:500px){.scaled{transform:scale(.4);transform-origin:top left}}
    </style></head><body><main><div class="reveal"><div class="slides">
      <section class="active"><h1>Readable first slide</h1></section>
      <section><p class="scaled">This text is visually smaller than twelve pixels</p></section>
    </div></div></main><script>
      const slides=[...document.querySelectorAll('.slides>section')];
      window.Reveal={slide(i){slides.forEach((s,n)=>s.classList.toggle('active',n===i));this.i=i},getIndices(){return {h:this.i||0}}};
    </script></body></html>`, 2);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const mobileSecond = result.measurements.find((measurement) => measurement.viewport === 'mobile' && measurement.slideIndex === 2)!;
    expect(result.measurements.filter((measurement) => measurement.viewport === 'mobile')).toHaveLength(2);
    expect(mobileSecond.issues.map((issue) => issue.issueCode)).toContain('presentation_text_too_small');
  }, 30_000);

  it('allows vertically scrollable mobile slides but rejects a fixed control covering their text', async () => {
    const sample = presentationWorkspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.reveal .slides>section{display:none}.reveal .slides>section.active{display:block}
      .long{min-height:1200px}.cover{position:fixed;left:0;right:0;top:0;height:90px;background:#fff}
    </style></head><body><main><div class="reveal"><div class="slides"><section class="active">
      <h1>Long readable slide</h1><p class="long">All content remains reachable by natural vertical scrolling.</p>
      <nav class="cover"><button type="button">Next slide</button></nav>
    </section></div></div></main><script>
      window.Reveal={slide(i){this.i=i},getIndices(){return {h:this.i||0}}};
    </script></body></html>`, 1);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const mobile = result.measurements.find((measurement) => measurement.viewport === 'mobile' && measurement.slideIndex === 1)!;
    expect(mobile.issues.map((issue) => issue.issueCode)).toContain('presentation_fixed_overlay_obscures_content');
    expect(mobile.issues.map((issue) => issue.issueCode)).not.toContain('main_content_clipped');
  }, 30_000);

  it('uses each Reveal slide as presentation main content without hiding real mobile defects', async () => {
    const slides = Array.from({ length: 20 }, (_, index) => {
      const number = index + 1;
      const className = [number === 1 ? 'active' : '', [4, 5, 16, 19].includes(number) ? 'overlap' : '']
        .filter(Boolean)
        .join(' ');
      const body = number === 1
        ? '<p class="small">Readable content must not be transform-shrunk.</p>'
        : `<p>Slide ${number} keeps its content reachable.</p>`;
      return `<section class="${className}"><h1>Slide ${number}</h1>${body}</section>`;
    }).join('');
    const sample = presentationWorkspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.reveal .slides>section{display:none;position:relative;min-height:844px}
      .reveal .slides>section.active{display:block}.small{font-size:11px}.overlap p{position:absolute;bottom:0;height:72px;margin:0}
      .controls{position:fixed;left:0;right:0;bottom:0;height:72px;background:#fff}
    </style></head><body><div class="reveal"><div class="slides">${slides}</div></div>
      <nav class="controls" aria-label="Slide navigation"><button type="button">Next</button></nav><script>
      const slides=[...document.querySelectorAll('.slides>section')];
      window.Reveal={slide(i){slides.forEach((s,n)=>s.classList.toggle('active',n===i));this.i=i},getIndices(){return {h:this.i||0}}};
    </script></body></html>`, 20);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const issues = result.measurements.flatMap((measurement) => measurement.issues);

    expect(result.measurements).toHaveLength(40);
    expect(issues.map((issue) => issue.issueCode)).not.toContain('main_content_clipped');
    expect(issues.map((issue) => issue.issueCode)).toContain('presentation_text_too_small');
    expect(issues.map((issue) => issue.issueCode)).toContain('presentation_fixed_overlay_obscures_content');
  }, 30_000);

  it('rejects a presentation when the expected current slide disappears after navigation', async () => {
    const sample = presentationWorkspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.reveal .slides>section{display:none;min-height:600px}
      .reveal .slides>section.active{display:block}
    </style></head><body><div class="reveal"><div class="slides">
      <section class="active"><h1>Only the first slide remains</h1></section>
      <section><h1>The second slide is removed during navigation</h1></section>
    </div></div><div id="unrelated"><h1>Unrelated visible body content</h1></div><script>
      const slides=[...document.querySelectorAll('.slides>section')];
      window.Reveal={slide(i){this.i=i;if(i===1)slides[1].remove()},getIndices(){return {h:this.i||0}}};
    </script></body></html>`, 2);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const secondSlideIssues = result.measurements
      .filter((measurement) => measurement.slideIndex === 2)
      .flatMap((measurement) => measurement.issues.map((issue) => issue.issueCode));

    expect(secondSlideIssues).toContain('main_content_clipped');
  }, 30_000);
});
