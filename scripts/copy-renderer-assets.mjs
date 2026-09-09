import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(projectRoot, 'src', 'renderer');
const outputDirectory = resolve(projectRoot, 'dist', 'renderer');

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  cp(resolve(sourceDirectory, 'index.html'), resolve(outputDirectory, 'index.html')),
  cp(resolve(sourceDirectory, 'styles.css'), resolve(outputDirectory, 'styles.css')),
]);
