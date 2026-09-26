'use strict';

// Scripts written for an interactive terminal emit colours, cursor moves and
// screen clears. Logs are read as plain text, so remove those sequences.
// Streamed output can split a sequence across chunks; an incomplete tail is
// held back until the next chunk arrives.
const SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const INCOMPLETE_TAIL = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function clean(text) {
  return text
    .replace(SEQUENCE, '')
    // A carriage return redraws the line; keep what was drawn last.
    .split('\n').map(line => line.includes('\r') ? line.split('\r').filter(Boolean).pop() || '' : line).join('\n')
    .replace(CONTROL, '')
    .replace(/\n{3,}/g, '\n\n');
}

function stripTerminalCodes(text) {
  return clean(String(text || ''));
}

function createTerminalTextFilter() {
  let pending = '';
  return {
    write(chunk) {
      const text = pending + String(chunk || '');
      const tail = text.match(INCOMPLETE_TAIL);
      pending = tail ? tail[0] : '';
      return clean(tail ? text.slice(0, tail.index) : text);
    },
    flush() {
      const rest = pending;
      pending = '';
      return clean(rest);
    },
  };
}

module.exports = { createTerminalTextFilter, stripTerminalCodes };
