# MR1 streetwear — GitHub Pages + Supabase

Loja MR1 com catálogo, sacola, pedidos por Pix manual e atendimento pelo painel. Supabase fornece Auth (clientes e administradores), PostgreSQL com regras de acesso por usuário, favoritos, histórico de pedidos, imagens e configurações visuais. Não há servidor Python na publicação do GitHub Pages.

Repositório: **FSLRV/demo-repository**. Domínio escolhido para o futuro: **https://mr1streetsp.com.br/**. Enquanto ele não é registrado, o endereço de publicação para testes é **https://fslrv.github.io/demo-repository/**. O endereço só fica ativo depois que a configuração Pages e o workflow de publicação tiverem sucesso.

Projeto Supabase selecionado: **https://tsrhrqwwunjyyujepppn.supabase.co**.

## Continuar editando no GitHub

Edite os arquivos na branch `main` e faça commit. O workflow **Publish MR1 to GitHub Pages** instala as dependências, gera `_site` e publica somente os arquivos públicos. `_site`, senhas, bancos locais, scripts administrativos e chaves privadas não são enviados ao Pages.

Em **Settings → Pages**, selecione **Source: GitHub Actions**. Se Pages ainda não estiver habilitado, a ativação requer uma conta com permissão sobre as configurações do repositório. O `GITHUB_TOKEN` do workflow não concede automaticamente essa permissão; o workflow aceita opcionalmente o secret `PAGES_ADMIN_TOKEN` com as permissões apropriadas.

### Domínio próprio escolhido

O responsável escolheu manter `mr1streetsp.com.br`. Esse domínio precisa estar registrado e apontar para GitHub Pages no provedor de DNS. Para o domínio raiz, o GitHub documenta estes registros:

| Tipo | Nome/host | Destino |
| --- | --- | --- |
| A | @ (raiz) | 185.199.108.153 |
| A | @ (raiz) | 185.199.109.153 |
| A | @ (raiz) | 185.199.110.153 |
| A | @ (raiz) | 185.199.111.153 |
| CNAME | www | fslrv.github.io |

No momento, a automação remove o redirecionamento para o domínio ainda não registrado, permitindo testar pelo endereço gratuito do GitHub. Depois de registrar o domínio e configurar o DNS, defina a variável de repositório `MR1_PAGES_USE_CUSTOM_DOMAIN=true` e configure **Settings → Pages → Custom domain** como `mr1streetsp.com.br`. Após a emissão do certificado, habilite **Enforce HTTPS**. Registros de e-mail e outros serviços não precisam ser alterados.

Durante o teste temporário, o retorno do Supabase Auth usa `https://fslrv.github.io/demo-repository/`. Redirecionamentos para o domínio não registrado são retirados até que ele pertença ao responsável. Ao ativar a variável do domínio próprio, a automação configura o retorno HTTPS correspondente.

## Conectar e configurar o Supabase

As migrações estão em `supabase/migrations/`. Elas criam apenas recursos prefixados `mr1_` e o bucket `mr1-media`, preservando tabelas de outros aplicativos no mesmo projeto. Reaplicar o catálogo inicial não sobrescreve preços, imagens ou configurações já editados.

Há duas formas de aplicar a configuração:

1. **Pela automação GitHub:** em Settings → Secrets and variables → Actions, adicione o secret `SUPABASE_ACCESS_TOKEN` da conta proprietária do projeto. Execute novamente **Publish MR1 to GitHub Pages**. A automação aplica as migrações, configura o endereço de retorno do Auth, exige confirmação de e-mail e gera `config.js` com a chave pública `anon`.
2. **Pelo ambiente de desenvolvimento:** configure `SUPABASE_ACCESS_TOKEN` como segredo seguro e permita `api.supabase.com` e o host do projeto. Execute `python3 scripts/provision-supabase.py --admin-email EMAIL_DO_RESPONSAVEL`. O script aplica as mesmas migrações, configura o Auth, grava apenas a chave pública em `config.js` e cria o acesso administrativo se a conta ainda não existir. A senha nova vai para um arquivo privado fora do repositório; nunca para logs, Git ou Pages. Depois envie o `config.js` atualizado ao GitHub.

O token de administração não pode entrar em `config.js`. Esse arquivo aceita somente a URL e uma chave **publishable/anon**, cuja exposição é prevista pelo Supabase e depende das regras RLS. O build rejeita `service_role` e chaves `sb_secret_`.

Se preferir configurar a conexão pública sem o script, use as variáveis de repositório `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` ou edite os dois campos públicos em `config.js`. Isso **não substitui aplicar as migrações**.

Enquanto faltar a chave pública, a página mostra o catálogo de prévia e informa que as contas aguardam ativação. Não simula login nem grava dados locais como se fossem o banco online.

## Administrador e clientes

Clientes usam **Minha conta** no cabeçalho para criar conta, entrar, guardar favoritos e ver seus pedidos. A confirmação de cadastro depende do Auth/SMTP configurado no projeto Supabase. Não há senhas padrão.

A publicação prepara a autorização do e-mail administrativo informado pelo responsável. O banco guarda apenas seu digest: essa conta recebe a permissão uma única vez, após confirmar o e-mail pelo Supabase. Cadastro de outro endereço, metadados de perfil ou e-mail não confirmado não concedem acesso ao painel.

Para autorizar uma conta já criada e com e-mail confirmado, execute o workflow **Authorize existing MR1 administrator**, informando o e-mail. Ele usa o secret `SUPABASE_ACCESS_TOKEN` e concede a permissão somente à conta confirmada. Não vincula privilégios a um e-mail não verificado e não permite que clientes se promovam.

Em **Gerenciar loja**, o administrador pode:

- Cadastrar peças, fotos, tamanhos, estoque, preços e promoções.
- Alterar o logo principal, o logo claro e a foto da capa.
- Editar nome, textos, contatos, cores principal/de destaque/de fundo.
- Conferir pedidos, informar o frete dos Correios, liberar o Pix, confirmar recebimento e registrar postagem/rastreio.

Fotos enviadas podem ser PNG, JPG ou WebP, de até 2 MB. Prefira PNG transparente para logos. Os SVGs originais da MR1 permanecem no repositório; upload de SVG arbitrário não é aceito.

## Proteção do banco

| Recurso | Acesso pelo navegador |
| --- | --- |
| `mr1_products`, `mr1_site_settings` | Leitura pública; edição apenas para administradores. |
| `mr1_profiles`, `mr1_favorites` | Apenas o próprio cliente autenticado. |
| `mr1_orders` | Leitura pelo dono ou administrador. Escrita direta bloqueada; funções do banco validam preços, estoque e cada transição de atendimento. |
| `mr1_admins` | Sem escrita por clientes; autorização pelo responsável pelo projeto. |
| `mr1-media` | Imagens públicas; envio apenas por administrador, em seu diretório. |

Histórico de pedidos depende do ID autenticado, não de uma coincidência de e-mail. Pedidos antigos de visitantes não são reivindicados automaticamente.

## Desenvolvimento e testes

Use o checkout existente, sem criar worktrees automaticamente.

```bash
npm ci
npm run check
npm test
npm run build
npm start
```

`npm start` serve `_site` com Python apenas como servidor local de arquivos estáticos. O frontend publicado usa diretamente o SDK oficial do Supabase, empacotado localmente, sem depender de CDN.

Para os testes de navegador:

```bash
npx playwright install chromium
npm run test:ui
```

Os testes usam o SDK real com respostas REST e CEP controladas, cobrindo cadastro/confirmação, login, favoritos, sacola, frete grátis na capital, Correios sob consulta, pedido, Pix manual, confirmação, rastreio e edição da loja em computador e celular. Não criam contas nem cobranças reais.

Para testar migrações e RLS, use um PostgreSQL **local e descartável** e defina `MR1_TEST_DATABASE_URL`. `npm run test:database` cria um banco temporário próprio, executa as migrações e verifica o bloqueio de acesso entre clientes, edição anônima, promoção indevida, manipulação de pedidos e uploads. O workflow de validação faz isso automaticamente com um serviço PostgreSQL isolado.

## Operação escolhida: Pix manual e Correios na agência

O cliente cria/confirma sua conta, informa o CEP na sacola e envia o pedido para análise. O banco usa o preço do catálogo, a identidade autenticada e uma chave de idempotência. O pedido aparece em **Minha conta → Meus pedidos** e em **Gerenciar loja → Pedidos recentes**.

- **São Paulo capital:** frete gratuito. A prévia consulta o município no ViaCEP (IBGE `3550308`); a Grande São Paulo tem frete dos Correios. Essa consulta identifica o endereço e não calcula tarifas dos Correios.
- **Demais destinos:** o pedido informa **frete a confirmar**, sem inventar valor ou prazo. Consulte os [preços e prazos dos Correios](https://www.correios.com.br/enviar/precos-e-prazos) com origem `05879-450`, destino, serviço e peso/dimensões reais da embalagem. A postagem é feita pessoalmente na agência.
- **Pix:** em cada pedido no painel, confirme o município no Busca CEP, informe o frete e o prazo e cole um Pix gerado no banco **com valor fixo igual ao total das peças mais o frete**. Códigos com valor divergente, sem valor fixo ou com checksum inválido são recusados. A loja deve conferir o recebedor no banco. Não há chave Pix padrão nem conta de recebimento cadastrada no código.
- **Estoque:** enviar uma solicitação não reserva peças. Ao liberar o Pix, o banco reserva a quantidade disponível numa transação; se faltar estoque, a liberação é recusada. O cancelamento de um pedido ainda não pago devolve a reserva uma única vez. Reservas ficam ativas até atendimento/cancelamento pelo lojista; não expiram automaticamente.
- **Recebimento:** o cliente pode clicar em **Já paguei o Pix**. Isso apenas avisa a loja. No painel, confirme o pagamento **depois de verificar o crédito na conta bancária**; comprovante ou clique do cliente não aprovam a compra.
- **Envio:** depois da confirmação, registre o código de rastreio fornecido na agência. O cliente consulta o código e acompanha o status em sua conta. Na entrega local, use **Confirmar entrega**.

Use **Atualizar pedidos** no painel e na área do cliente para consultar mudanças. Não há envio automático de e-mail/WhatsApp de pedidos, pagamento automático, etiqueta ou integração de tarifas contratadas. Pedidos pagos não são cancelados por essa ação: devoluções e reembolsos precisam ser tratados com o cliente e o banco.

O checkout depende do Supabase configurado. A migração `202611100001_manual_pix_orders.sql` é aplicada pela publicação existente, usando o secret já cadastrado. Não é necessário token de pagamento ou contrato dos Correios para este atendimento manual. A Edge Function de provedores automáticos permanece desativada como referência para uma integração futura.

As peças, valores, estoque e medidas iniciais são exemplos. As imagens MR1 geradas e as demais fontes estão em `assets/SOURCES.md`. Confira o catálogo e as medidas reais das peças embaladas antes de ativar vendas. A origem de envio informada é **05879-450**.

A implementação Python/SQLite anterior foi preservada no repositório como referência, com testes em `npm run test:legacy`; ela não é publicada nem usada pelo Pages. Credenciais e dados privados locais não são transferidos ao GitHub.

O workflow registra um resumo sem credenciais na branch `mr1-deployment-status`, em `deployment-status.json`. O relatório informa o resultado do banco, do Pages e da verificação da loja publicada. Nenhum token, senha ou conteúdo privado de pedidos entra nesse arquivo.
