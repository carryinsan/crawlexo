import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const files = ['api/search.js', 'api/retrieve.js'];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}
const htmlFiles = ['index.html', 'extractor.html', 'search-console.html'];
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((x) => x.trim());
  for (let i = 0; i < scripts.length; i++) {
    const temp = path.join('/tmp', `arix-${path.basename(file)}-${i}.js`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(temp, scripts[i]);
    const result = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(`${file} inline script ${i + 1}:\n${result.stderr || result.stdout}`);
      process.exit(result.status || 1);
    }
  }
}
console.log(`Syntax checks passed: ${files.length} API modules and ${htmlFiles.length} HTML consoles.`);
