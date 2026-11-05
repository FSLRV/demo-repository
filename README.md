# MR1 streetwear — GitHub Pages + Supabase

Site estático com a identidade MR1, catálogo e sacola. Supabase fornece Auth (clientes e administradores), PostgreSQL com regras de acesso por usuário, favoritos, histórico de pedidos, imagens e configurações visuais. Não há servidor Python na publicação do GitHub Pages.

Repositório: **FSLRV/demo-repository**. Endereço previsto do Pages: **https://fslrv.github.io/demo-repository/**. O endereço só fica ativo depois que a configuração Pages e o workflow de publicação tiverem sucesso.

Projeto Supabase selecionado: **https://tsrhrqwwunjyyujepppn.supabase.co**.

## Continuar editando no GitHub

Edite os arquivos na branch `main` e faça commit. O workflow **Publish MR1 to GitHub Pages** instala as dependências, gera `_site` e publica somente os arquivos públicos. `_site`, senhas, bancos locais, scripts administrativos e chaves privadas não são enviados ao Pages.

Em **Settings → Pages**, selecione **Source: GitHub Actions**. Se Pages ainda não estiver habilitado, a ativação requer uma conta com permissão sobre as configurações do repositório. O `GITHUB_TOKEN` do workflow não concede automaticamente essa permissão; o workflow aceita opcionalmente o secret `PAGES_ADMIN_TOKEN` com as permissões apropriadas.

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

Para autorizar uma conta já criada e com e-mail confirmado, execute o workflow **Authorize existing MR1 administrator**, informando o e-mail. Ele usa o secret `SUPABASE_ACCESS_TOKEN` e concede a permissão somente à conta confirmada. Não vincula privilégios a um e-mail não verificado e não permite que clientes se promovam.

Em **Gerenciar loja**, o administrador pode:

- Cadastrar peças, fotos, tamanhos, estoque, preços e promoções.
- Alterar o logo principal, o logo claro e a foto da capa.
- Editar nome, textos, contatos, cores principal/de destaque/de fundo.
- Consultar pedidos e os dados de entrega disponíveis no banco.

Fotos enviadas podem ser PNG, JPG ou WebP, de até 2 MB. Prefira PNG transparente para logos. Os SVGs originais da MR1 permanecem no repositório; upload de SVG arbitrário não é aceito.

## Proteção do banco

| Recurso | Acesso pelo navegador |
| --- | --- |
| `mr1_products`, `mr1_site_settings` | Leitura pública; edição apenas para administradores. |
| `mr1_profiles`, `mr1_favorites` | Apenas o próprio cliente autenticado. |
| `mr1_orders` | Leitura pelo dono do pedido ou administrador; nenhuma criação/alteração de valores ou status pago pelo navegador. |
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

Os testes usam o SDK real com respostas REST controladas, cobrindo cadastro/confirmação, login, favoritos, sacola, edição de preços, logos, imagens e cores em computador e celular. Não criam contas nem cobranças reais.

Para testar migrações e RLS, use um PostgreSQL **local e descartável** e defina `MR1_TEST_DATABASE_URL`. `npm run test:database` cria um banco temporário próprio, executa as migrações e verifica o bloqueio de acesso entre clientes, edição anônima, promoção indevida, manipulação de pedidos e uploads. O workflow de validação faz isso automaticamente com um serviço PostgreSQL isolado.

## Limites atuais

O usuário informou utilizar outros provedores de pagamento e frete, mas ainda não informou os nomes. Compra e frete permanecem desativados. O site não inventa cotações nem marca pagamentos como aprovados. A implementação futura deve ficar em Supabase Edge Functions com segredos no servidor; `supabase/functions/store-api` contém uma resposta segura de serviço ainda não configurado.

As peças, valores, estoque e medidas iniciais são exemplos. As imagens MR1 geradas e as demais fontes estão em `assets/SOURCES.md`. Confira o catálogo e as medidas reais das peças embaladas antes de ativar vendas. A origem de envio informada é **05879-450**.

A implementação Python/SQLite anterior foi preservada no repositório como referência, com testes em `npm run test:legacy`; ela não é publicada nem usada pelo Pages. Credenciais e dados privados locais não são transferidos ao GitHub.
