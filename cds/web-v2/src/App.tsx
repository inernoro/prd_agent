import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { HelloPage } from '@/pages/HelloPage';

/*
 * Router root.
 *
 * Mounted under `/v2/` (see vite.config.ts `base`). Express serves
 * `web-v2-dist/index.html` for any unmatched `/v2/*` so client-side routing
 * works on hard reload — but the route table is intentionally tiny while
 * the migration is in Week 1 (foundation only).
 *
 * Future routes (per doc/handoff.cds-web-v2-migration.md):
 *   /v2/cds-settings        Week 2
 *   /v2/settings            Week 3 (project settings)
 *   /v2/project-list        Week 3
 *   /v2/branch-list         Week 4
 *   /v2/branch-panel/:id    Week 4
 */
export function App(): JSX.Element {
  return (
    <BrowserRouter basename="/v2">
      <Routes>
        <Route path="/" element={<HelloPage />} />
        <Route path="/hello" element={<HelloPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
