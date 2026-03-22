function findMatchingBracket(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '[') depth++;
    else if (str[i] === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function parseImageUpdateOutput(stdout) {
  const marker = stdout.indexOf('"msg": [');
  if (marker === -1) return [];
  const arrayStart = stdout.indexOf('[', marker);
  const jsonEnd = findMatchingBracket(stdout, arrayStart);
  if (jsonEnd === -1) return [];
  try {
    return JSON.parse(stdout.substring(arrayStart, jsonEnd + 1))
      .filter(line => line && line.includes('|'))
      .map(line => {
        const [image, status] = line.split('|');
        return { image: image.trim(), status: (status || 'unknown').trim() };
      });
  } catch { return []; }
}

module.exports = { parseImageUpdateOutput };
