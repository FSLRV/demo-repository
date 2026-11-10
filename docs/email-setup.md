# Enviar confirmações de cadastro da MR1

O Supabase exige confirmação de e-mail para entrar na conta. O envio padrão é restrito; configure SMTP próprio para receber cadastros de clientes externos. O site já está publicado em https://fslrv.github.io/demo-repository/.

Para os primeiros testes, é possível usar o Gmail administrativo informado pelo responsável. A senha normal do Gmail não deve ser utilizada no Supabase.

## 1. Preparar a conta Google

1. Entre na conta **seu Gmail administrativo**.
2. Ative a [verificação em duas etapas](https://myaccount.google.com/signinoptions/two-step-verification), se ainda não estiver ativa.
3. Abra [Senhas de app](https://myaccount.google.com/apppasswords).
4. Crie uma senha de app com o nome **MR1 Supabase**. O Google fornece uma senha de 16 caracteres. Guarde-a apenas nas configurações SMTP do Supabase; não envie pelo chat, não use em `config.js`, não faça commit no GitHub.

Se a opção não aparecer, confira se a verificação em duas etapas está ativa e se você entrou na conta correta. Contas sob certas políticas do Google podem não oferecer senhas de app. Nesse caso, será necessário outro provedor SMTP.

## 2. Preencher o Supabase

Abra [SMTP do projeto MR1](https://supabase.com/dashboard/project/tsrhrqwwunjyyujepppn/auth/smtp), ou entre no projeto e navegue por **Authentication → Email → SMTP Settings**. Habilite **Custom SMTP** e preencha:

| Campo | Valor |
| --- | --- |
| Sender email address | `seu-email@gmail.com` |
| Sender name | `MR1 streetwear` |
| Host | `smtp.gmail.com` |
| Port | `465` |
| Username | `seu-email@gmail.com` |
| Password | A senha de app gerada no Google, sem espaços |

Substitua `seu-email@gmail.com` pelo Gmail administrativo informado no atendimento, em todos os campos de e-mail e usuário. Mantenha a conexão segura/TLS e salve. A senha fica no Supabase, não no navegador da loja nem no GitHub Pages. Esta etapa não exige outro token de acesso do Supabase. O Gmail tem limites de envio; para ampliar o volume da loja, utilize um provedor de e-mail transacional e um domínio verificado.

## 3. Confirmar o primeiro acesso

1. Abra a loja e clique em **Gerenciar loja → Criar meu acesso à loja** (ou **Minha conta → Criar conta**).
2. Use o e-mail administrativo acima e escolha uma senha própria com pelo menos 12 caracteres.
3. Abra a mensagem de confirmação na caixa de entrada ou no spam. O link deve voltar para o endereço publicado da loja.
4. Depois de confirmar, entre em **Gerenciar loja** com o mesmo e-mail e senha. A autorização administrativa é concedida somente à conta confirmada do responsável.
5. Para uma conta já cadastrada, abra **Minha conta → Entrar**, informe o e-mail e clique em **Reenviar confirmação de e-mail**. Não precisa informar senha para pedir o reenvio. Confira o spam e aguarde alguns minutos se houver aviso de muitas tentativas.
6. Teste também uma nova conta de cliente com outro endereço de e-mail ao qual você tenha acesso. Confirme que essa conta consegue entrar e consultar seus próprios pedidos e favoritos.

Não desabilite a confirmação de e-mail para contornar problemas de envio: a autorização inicial da administração depende de comprovar a propriedade do e-mail.

Se uma mensagem falhar, consulte os logs de Auth do Supabase e o limite de envios em **Authentication → Rate Limits**. Um SMTP salvo não comprova que a senha está correta ou que a mensagem foi entregue: o cadastro e a confirmação acima são a validação final. Alterações SMTP salvas valem imediatamente para novos envios, sem republicar o site.

## 4. Atender pedidos

No painel, revise fotos, preços, tamanhos e estoque antes de divulgar a loja. As peças iniciais são exemplos.

Em **Pedidos recentes → pedido**, confirme o município, informe o prazo e o frete (capital gratuita; demais destinos pelos Correios), gere no banco um Pix com o total exato e cole o código. O cliente encontra o Pix em **Minha conta → Meus pedidos**. Confirme o recebimento apenas após conferir o crédito na conta bancária. Depois da postagem na agência, informe o rastreio.
