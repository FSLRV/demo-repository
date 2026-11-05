import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const run = (extra = {}) => {
  const env = { ...process.env, SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ...extra };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['scripts/build.mjs'], { env, encoding: 'utf8' });
};

test('Pages publica apenas arquivos públicos e funciona no subdiretório do repositório', async () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir('_site');
  for (const name of ['server.py','customers.py','site_settings.py','.env','.env.example','.git','tests','supabase','node_modules','scripts']) assert.ok(!files.includes(name), name);
  for (const name of ['index.html','app.js','backend.js','supabase-sdk.js','account.js','site-editor.js','config.js','theme.css','.nojekyll']) assert.ok(files.includes(name), name);
  const html = await readFile('_site/index.html','utf8');
  assert.ok(!/(?:src|href)=["']\/(?:assets|app|styles|config|account|theme|site-editor)/.test(html), 'Assets precisam de caminhos relativos ao projeto Pages');
  assert.ok(html.includes('id="account-button"') && html.includes('id="site-editor-section"'));
  const cfg = await readFile('_site/config.js','utf8');
  assert.ok(!cfg.includes('service_role') && !cfg.includes('sb_secret_'));
});

test('O build rejeita chaves administrativas antes de publicar configuração', () => {
  for (const key of ['sb_secret_fixture_should_never_publish', 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url') + '.fixture']) {
    const result = run({ SUPABASE_URL:'https://tsrhrqwwunjyyujepppn.supabase.co', SUPABASE_PUBLISHABLE_KEY:key });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/administrativas/);
  }
  assert.equal(run().status,0);
});

test('Publicação não exporta usuários nem pedidos da implementação local anterior', async () => {
  const catalog = JSON.parse(await readFile('_site/data/catalog.json','utf8'));
  assert.equal(catalog.products.length,6);
  const keys = Object.keys(catalog);
  assert.deepEqual(keys,['products']);
  const all = JSON.stringify(catalog);
  assert.ok(!all.includes('password_hash') && !all.includes('customer_id'));
});
