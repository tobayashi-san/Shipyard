'use strict';

const { stripTerminalCodes } = require('./terminal-text');

function executionSummary(status, output) {
  // Update scripts decorate lines with symbols; the reader needs the words.
  const lines = stripTerminalCodes(output).split('\n').map(line => line.replace(/^[^\p{L}\p{N}]+/u, '').trim()).filter(Boolean);
  if (status === 'failed') {
    if (!lines.length) return 'No error details were recorded.';
    const explicit = lines.filter(line => /(?:^|\b)(?:error:|fatal:|failed!|exception:|permission denied|connection refused|timed out|lock unavailable|unable to|could not|not continuing|no space left|snapshot failed)\s*/i.test(line));
    return explicit.at(-1)?.slice(0, 500) || 'Failure cause not identified; open the full log.';
  }
  return lines.at(-1)?.slice(0, 500) || 'No execution output recorded.';
}

module.exports = { executionSummary };
