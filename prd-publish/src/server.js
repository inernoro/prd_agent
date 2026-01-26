import { createApp } from './app.js';
import { config, validateConfig } from './config.js';

// Validate configuration
const validation = validateConfig();
if (!validation.valid) {
  console.error('Configuration errors:');
  validation.errors.forEach((e) => console.error(`  - ${e}`));
  console.error('\nPlease check your .env file');
  process.exit(1);
}

// Create and start server
const app = createApp();

const server = app.listen(config.server.port, config.server.host, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║        PRD-Publish Server             ║');
  console.log('  ╠═══════════════════════════════════════╣');
  console.log(`  ║  URL: http://${config.server.host}:${config.server.port}`.padEnd(42) + '║');
  console.log(`  ║  Repo: ${config.git.repoPath.slice(0, 30)}...`.padEnd(42) + '║');
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
