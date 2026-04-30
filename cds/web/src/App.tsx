import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { BranchDetailPage } from '@/pages/BranchDetailPage';
import { BranchListPage } from '@/pages/BranchListPage';
import { BranchTopologyPage } from '@/pages/BranchTopologyPage';
import { CdsSettingsPage } from '@/pages/CdsSettingsPage';
import { HelloPage } from '@/pages/HelloPage';
import { ProjectListPage } from '@/pages/ProjectListPage';
import { ProjectSettingsPage } from '@/pages/ProjectSettingsPage';

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
 *   /cds-settings           CDS system settings
 *   /project-list           Project list
 *   /branches/:projectId    Branch list + one-click preview
 *   /branch-list?project=   Back-compat entry to the React branch list
 *   /branch-panel/:branchId Branch detail + logs + single-service actions
 *   /branch-topology        Project service topology
 *   /settings/:projectId    Project settings
 */
export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/hello" element={<HelloPage />} />
        <Route path="/cds-settings" element={<CdsSettingsPage />} />
        <Route path="/project-list" element={<ProjectListPage />} />
        <Route path="/branches/:projectId" element={<BranchListPage />} />
        <Route path="/branch-list" element={<BranchListPage />} />
        <Route path="/branch-panel" element={<BranchDetailPage />} />
        <Route path="/branch-panel/:branchId" element={<BranchDetailPage />} />
        <Route path="/branch-topology" element={<BranchTopologyPage />} />
        <Route path="/settings/:projectId" element={<ProjectSettingsPage />} />
        <Route path="*" element={<Navigate to="/project-list" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
