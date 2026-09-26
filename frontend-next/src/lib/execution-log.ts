// Logs recorded before the server stripped terminal codes still carry colours,
// cursor moves and screen clears; remove them the same way for display.
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripTerminalCodes(output: string): string {
  return output
    .replace(TERMINAL_SEQUENCE, '')
    .split('\n').map(line => line.includes('\r') ? line.split('\r').filter(Boolean).pop() || '' : line).join('\n')
    .replace(CONTROL, '');
}

/** Preserve multiline host messages and task headings when filtering default Ansible output. */
export function filterExecutionLog(output: string, query: string, host: string): string {
  const lines = stripTerminalCodes(output).split(/\r?\n/);
  const blocks: Array<{host: string | null; heading: string; lines: string[]}> = [];
  let heading = '';
  let current: typeof blocks[number] | undefined;
  for (const line of lines) {
    if (/^(TASK|RUNNING HANDLER|PLAY|PLAY RECAP)\s/.test(line)) {
      heading = line; current = undefined;
      if (!host) blocks.push({host: null, heading: '', lines: [line]});
      continue;
    }
    const name = line.match(/^(?:ok|changed|fatal|skipping|unreachable):\s*\[([^\]]+?)\](?:\s|:|$)/)?.[1]?.split(' -> ')[0]
      || line.match(/^\s*(\S+)\s*:\s*ok=\d+/)?.[1];
    if (name || !current) {
      current = {host: name || null, heading, lines: []}; blocks.push(current);
    }
    current.lines.push(line);
  }
  const matched = blocks.filter(block => (!host || block.host === host) && (!query.trim() || block.lines.join('\n').toLowerCase().includes(query.trim().toLowerCase())));
  let previousHeading = '';
  return matched.flatMap(block => {
    const prefix = host && block.heading && block.heading !== previousHeading ? [block.heading] : [];
    previousHeading = block.heading;
    return [...prefix, ...block.lines];
  }).join('\n');
}
