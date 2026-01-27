import { createApp } from './app.js';
import { config, validateConfig } from './config.js';

// ASCII Art Logo
const LOGO = `
\x1b[36m
  ██████╗ ██████╗ ██████╗       ██████╗ ██╗   ██╗██████╗ ██╗     ██╗███████╗██╗  ██╗
  ██╔══██╗██╔══██╗██╔══██╗      ██╔══██╗██║   ██║██╔══██╗██║     ██║██╔════╝██║  ██║
  ██████╔╝██████╔╝██║  ██║█████╗██████╔╝██║   ██║██████╔╝██║     ██║███████╗███████║
  ██╔═══╝ ██╔══██╗██║  ██║╚════╝██╔═══╝ ██║   ██║██╔══██╗██║     ██║╚════██║██╔══██║
  ██║     ██║  ██║██████╔╝      ██║     ╚██████╔╝██████╔╝███████╗██║███████║██║  ██║
  ╚═╝     ╚═╝  ╚═╝╚═════╝       ╚═╝      ╚═════╝ ╚═════╝ ╚══════╝╚═╝╚══════╝╚═╝  ╚═╝
\x1b[0m
\x1b[90m  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[33m  ⚡ Lightweight Release Management System\x1b[0m
\x1b[90m  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
`;

// Validate configuration
const validation = validateConfig();
if (!validation.valid) {
  console.error('\x1b[31m✖ Configuration errors:\x1b[0m');
  validation.errors.forEach((e) => console.error(`  \x1b[31m•\x1b[0m ${e}`));
  console.error('\n  Please check your .env file');
  process.exit(1);
}

// Create and start server
const app = createApp();

const server = app.listen(config.server.port, config.server.host, () => {
  console.log(LOGO);
  console.log(`  \x1b[32m●\x1b[0m Server     \x1b[90m→\x1b[0m  \x1b[36mhttp://${config.server.host}:${config.server.port}\x1b[0m`);
  console.log(`  \x1b[32m●\x1b[0m Repository \x1b[90m→\x1b[0m  ${config.git.repoPath}`);
  console.log(`  \x1b[32m●\x1b[0m Branch     \x1b[90m→\x1b[0m  ${config.git.branch}`);
  console.log(`  \x1b[32m●\x1b[0m Script     \x1b[90m→\x1b[0m  ${config.exec.script}`);
  console.log('');
  console.log('\x1b[90m  Press Ctrl+C to stop\x1b[0m');
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
