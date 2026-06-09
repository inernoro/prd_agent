/**
 * Minimal CLI for exec_cds.sh to generate static HTML files from TypeScript sources.
 * Usage: node dist/cli/render-page.js <page-name>
 *
 * Called by exec_cds.sh write_waiting_html() during nginx-render:
 *   node "$SCRIPT_DIR/dist/cli/render-page.js" nginx-waiting > /var/www/html/cds-waiting.html
 */
import { fileURLToPath } from 'node:url';
import { buildNginxWaitingHtml } from '../loading-pages/index.js';

// Guard: only run CLI logic when executed directly, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = process.argv[2];

  switch (page) {
    case 'nginx-waiting':
      process.stdout.write(buildNginxWaitingHtml());
      break;
    default:
      process.stderr.write(`render-page: unknown page "${page ?? ''}"\nAvailable: nginx-waiting\n`);
      process.exit(1);
  }
}
