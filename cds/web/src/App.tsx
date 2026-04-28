import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { HelloPage } from '@/pages/HelloPage';

/*
 * Router root for the React-based CDS Dashboard.
 *
 * The Express server (cds/src/server.ts) holds a list of migrated routes and
 * serves the built React index.html for them. Unmigrated paths still resolve
 * to legacy static pages under cds/web-legacy/, so each migration step is a
 * single addition to MIGRATED_REACT_ROUTES + a new <Route> here.
 *
 * Currently migrated:
 *   /hello                  Foundation demo page (Tailwind / theme / API / Dialog)
 *
 * Pending (see doc/plan.cds-web-migration.md):
 *   /cds-settings           Week 2
 *   /settings/:projectId    Week 3 (project settings)
 *   /projects               Week 3 (project list)
 *   /                       Week 4 (branch list — replaces legacy index.html)
 *   /branch-panel/:id       Week 4
 */
export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/hello" element={<HelloPage />} />
        <Route path="*" element={<Navigate to="/hello" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
