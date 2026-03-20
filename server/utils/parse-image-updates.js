function parseImageUpdateOutput(stdout) {
  const jsonStart = stdout.indexOf('"msg": [');
  if (jsonStart === -1) return [];
  const jsonEnd = stdout.indexOf(']', jsonStart);
  if (jsonEnd === -1) return [];
  try {
    return JSON.parse(stdout.substring(jsonStart + 7, jsonEnd + 1))
      .filter(line => line && line.includes('|'))
      .map(line => {
        const [image, status] = line.split('|');
        return { image: image.trim(), status: (status || 'unknown').trim() };
      });
  } catch { return []; }
}

module.exports = { parseImageUpdateOutput };
