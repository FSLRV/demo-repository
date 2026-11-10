// The active store uses reviewed requests and manual Pix via database RPCs.
// This optional automatic-provider endpoint stays disabled: Correios posting
// and bank receipt verification are performed by the owner.
Deno.serve((request: Request) => {
  const origin = Deno.env.get('MR1_SITE_ORIGIN') || 'https://fslrv.github.io';
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Vary': 'Origin' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify({ error: 'Provedor de pagamento ou frete ainda não configurado pela loja.', code: 'provider_not_configured' }), { status: 503, headers });
});
