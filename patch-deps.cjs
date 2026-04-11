const fs = require('fs');
const path = require('path');

const targets = [
  { file: 'node_modules/ink/build/reconciler.js', find: /await import\('\.\/devtools\.js'\)/g, replace: 'Promise.resolve()' },
  { file: 'node_modules/xml2js/lib/xml2js.js', find: /ValidationError\.name\s*=\s*['"]ValidationError['"];/g, replace: '// Patched' },
  { file: 'node_modules/xml2js/lib/xml2js.js', find: /Parser\.name\s*=\s*['"]Parser['"];/g, replace: '// Patched' }
];

for (const target of targets) {
  const p = path.resolve(target.file);
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, 'utf8');
    const newContent = content.replace(target.find, target.replace);
    if (content !== newContent) {
      fs.writeFileSync(p, newContent);
      console.log(`✅ Patched: ${target.file}`);
    } else {
        console.log(`ℹ️ Already patched or not found: ${target.file}`);
    }
  } else {
    console.warn(`❌ Not found: ${target.file}`);
  }
}
