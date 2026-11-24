export function designFrameworkRules(markdown: string) {
  const rules = new Map<string, { name: string; method?: string }>();
  for (const line of markdown.split(/\r?\n/)) {
    const row = line.match(/^\s*\|\s*(R[-_]\d+)\s*\|\s*(.+?)\s*(?<!\\)\|(?:\s*(.+?)\s*\|)?\s*$/);
    if (row) {
      const [, id, description, method] = row;
      rules.set(id, { name: description.replace(/\\\|/g, '|'), method });
      continue;
    }
    const heading = line.match(/^#{2,4}\s+(R[-_]\d+)(?:\s+|\s*[·—:：]\s*)(.+)$/);
    if (heading && !rules.has(heading[1])) rules.set(heading[1], { name: heading[2] });
  }
  return rules;
}
