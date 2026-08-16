import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const publicKeys = [
  'VITE_CONTACT_EMAIL',
  'VITE_FRONT_END_PDA_LINKS_JSON',
  'VITE_FRONT_END_PROJECT_REGISTRY_JSON',
  'VITE_PA_LEARN_MORE_URL',
  'VITE_PUBLIC_DOCS_URL',
];

const runtimeConfig = Object.fromEntries(
  publicKeys.flatMap((key) => {
    const value = process.env[key]?.trim();
    return value ? [[key, value]] : [];
  }),
);

await writeFile(
  new URL('../dist/runtime-config.js', import.meta.url),
  `window.__MAP_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`,
  'utf8',
);

const server = spawn('serve', ['-s', 'dist', '-l', '8080'], { stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}

server.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
