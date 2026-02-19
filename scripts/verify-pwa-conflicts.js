const fs = require('fs');
const path = require('path');

const files = ['public/manifest.json', 'public/sw.js'];
const markers = ['<<<<<<<', '=======', '>>>>>>>'];

let failed = false;
for (const rel of files) {
  const full = path.join(process.cwd(), rel);
  const text = fs.readFileSync(full, 'utf8');
  const marker = markers.find((m) => text.includes(m));
  if (marker) {
    failed = true;
    console.error(`Conflict marker '${marker}' found in ${rel}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/manifest.json'), 'utf8'));
if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
  failed = true;
  console.error('Manifest must include non-empty icons for installability.');
}

if (failed) process.exit(1);
console.log('PWA conflict/manifest checks passed.');
