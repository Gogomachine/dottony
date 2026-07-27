import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

/**
 * Сборка сервера в один JS-файл.
 *
 * Внешними оставляем только настоящие npm-зависимости (они приедут в
 * node_modules и содержат нативные бинарники, которые бандлить нельзя).
 * Пакеты воркспейса — это TypeScript-исходники без сборки, поэтому они
 * должны попасть внутрь бандла: иначе Node не сможет их загрузить.
 */
const pkg = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith('@doton/'),
);

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  logLevel: 'info',
});
