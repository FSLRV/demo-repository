import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const files = ['app.js','account.js','site-editor.js','backend.js','theme.js','config.js','scripts/build.mjs','tests/storefront.cjs'];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const html = await readFile('index.html','utf8');
for (const id of ['account-dialog','account-button','account-view','site-editor-section','site-theme']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Elemento obrigatório ausente: ${id}`);
}
console.log('JavaScript e pontos de integração verificados.');
