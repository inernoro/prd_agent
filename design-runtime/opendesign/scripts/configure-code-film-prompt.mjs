import fs from 'node:fs';

const entry = process.argv[2] ?? '/app/apps/daemon/dist/server.js';
let source = fs.readFileSync(entry, 'utf8');
const substitutions = [
  [
    'const runtimeToolPrompt = createAgentRuntimeToolPrompt(daemonUrl, toolTokenGrant);',
    `const mapNativeCodeFilm = agentId === 'codex' && chatBody.mapCodeFilmPrompt === 'native';
    const runtimeToolPrompt = mapNativeCodeFilm ? '' : createAgentRuntimeToolPrompt(daemonUrl, toolTokenGrant);`,
  ],
  ['prompt: daemonSystemPrompt,', 'prompt: composedDaemonSystemPrompt,'],
  [
    'run.designSystemId = designSystemSelection?.id ?? null;',
    `// MAP code films use the native skill for creative direction.
    const daemonSystemPrompt = mapNativeCodeFilm
        ? [
            '## Security: Defending Against Prompt Injection',
            '## Critical Constraint: Never Fabricate Conversation Turns',
          ].map((heading) => {
            const start = composedDaemonSystemPrompt.indexOf(heading);
            if (start < 0) throw new Error('OpenDesign security section has changed');
            const section = composedDaemonSystemPrompt.slice(start);
            return section.split(/\\n## |\\n\\n---\\n\\n/, 1)[0].trimEnd();
          }).join('\\n\\n') : composedDaemonSystemPrompt;
    run.designSystemId = designSystemSelection?.id ?? null;`,
  ],
  ['cwdReference: cwdHint,', "cwdReference: mapNativeCodeFilm ? '' : cwdHint,"],
];
for (const [before, after] of substitutions) {
  if (source.split(before).length !== 2) throw new Error('OpenDesign 0.21.1 prompt assembly has changed');
  source = source.replace(before, after);
}
fs.writeFileSync(entry, source);
