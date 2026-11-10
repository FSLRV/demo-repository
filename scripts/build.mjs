import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '_site');
const publicFiles = ['index.html', 'styles.css', 'theme.css', 'theme.js', 'backend.js', 'manual-commerce.js', 'app.js', 'account.js', 'site-editor.js', 'assets', 'data'];
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of publicFiles) await cp(path.join(root, file), path.join(output, file), { recursive: true });

const source = await readFile(path.join(root, 'config.js'), 'utf8');
const match = source.match(/['"]?supabaseUrl['"]?\s*:\s*['"]([^'"]*)['"][\s\S]*?['"]?supabasePublishableKey['"]?\s*:\s*['"]([^'"]*)['"]/);
if (!match) throw new Error('config.js inválido');
const config = {
  supabaseUrl: process.env.SUPABASE_URL || match[1],
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || match[2]
};
if (config.supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(config.supabaseUrl)) throw new Error('SUPABASE_URL deve ser a URL HTTPS do projeto Supabase');
if (config.supabasePublishableKey) {
  const key = config.supabasePublishableKey;
  let allowed = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (key.startsWith('eyJ')) {
    try { allowed = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; } catch { allowed = false; }
  }
  if (!allowed) throw new Error('Somente chave publicável/anon é permitida no site. Chaves administrativas são proibidas.');
}
if (!config.supabasePublishableKey) console.log('Supabase ainda sem chave publicável: o catálogo de prévia será publicado; contas aguardam configuração.');
await writeFile(path.join(output, 'config.js'), '// Apenas configuração pública.\nwindow.MR1_CONFIG = Object.freeze(' + JSON.stringify(config) + ');\n');
await build({ entryPoints: [path.join(root, 'scripts/supabase-entry.js')], outfile: path.join(output, 'supabase-sdk.js'), bundle: true, minify: true, format: 'iife', globalName: 'SupabaseSDK', platform: 'browser', target: ['es2020'], legalComments: 'eof' });
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Site estático gerado em _site; banco, código privado e credenciais não foram incluídos.');
