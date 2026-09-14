// Extracts the inline <script> blocks from recovery.html and syntax-checks them
// with node --check, the same way the FieldLink CI checks its kiosk page.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'recovery.html'), 'utf8');
const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
if (!blocks.length) { console.error('recovery.html: no inline scripts found'); process.exit(1); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flk-recovery-'));
blocks.forEach((src, i) => {
  const file = path.join(dir, `script-${i}.js`);
  fs.writeFileSync(file, src);
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(`recovery.html: ${blocks.length} inline script block(s) OK`);
