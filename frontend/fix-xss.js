const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');

function walk(dir) {
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else processFile(p);
  });
}

function processFile(filePath) {
  if (!filePath.endsWith('.js') || filePath.includes('format.js')) return;

  let code = fs.readFileSync(filePath, 'utf8');
  if (!code.includes('.innerHTML')) return;

  const originalLength = code.length;

  code = code.replace(/\.innerHTML\s*=\s*(`[\s\S]*?`)/g, '.innerHTML = sanitizeHTML($1)');
  code = code.replace(/\.innerHTML\s*=\s*('[\s\S]*?')/g, '.innerHTML = sanitizeHTML($1)');
  code = code.replace(/\.innerHTML\s*=\s*("[\s\S]*?")/g, '.innerHTML = sanitizeHTML($1)');

  if (code.length !== originalLength && !code.includes('import { sanitizeHTML }')) {
    const relToSrc = path.relative(path.dirname(filePath), path.join(srcDir, 'utils', 'format.js')).replace(/\\/g, '/');
    const importPath = relToSrc.startsWith('.') ? relToSrc : './' + relToSrc;
    
    // Add import statement at the very top
    code = `import { sanitizeHTML } from '${importPath}';\n` + code;
    
    // Also, if the file imports from format.js already, we might have duplicate imports, but JS allows duplicate ES imports from the same file.
  }
  
  fs.writeFileSync(filePath, code);
  console.log('Fixed', filePath);
}

walk(srcDir);
