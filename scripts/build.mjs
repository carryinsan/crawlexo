import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(projectRoot, 'public');
const pages = ['index.html', 'extractor.html', 'search-console.html'];

await mkdir(outputDirectory, { recursive: true });
for (const page of pages) {
  await copyFile(
    path.join(projectRoot, page),
    path.join(outputDirectory, page),
  );
}

console.log(`Prepared Vercel output directory with ${pages.length} HTML pages.`);
