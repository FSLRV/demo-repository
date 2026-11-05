// Payment/shipping providers were not identified by the owner. Never invent a
// quote or accept a client-provided price/paid status. Implement the selected
// provider here using Edge Function secrets before enabling checkout.
Deno.serve((request: Request) => {
  const origin = Deno.env.get('MR1_SITE_ORIGIN') || 'https://fslrv.github.io';
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Vary': 'Origin' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify({ error: 'Provedor de pagamento ou frete ainda não configurado pela loja.', code: 'provider_not_configured' }), { status: 503, headers });
});
