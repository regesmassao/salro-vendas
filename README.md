# Salro Vendas

Quinto app da família Salro. Controle de lucro por venda para quem
vende produtos digitais: para cada venda, a conta completa — bruto →
taxa da plataforma → líquido da plataforma → reserva de imposto →
lucro líquido — mais despesas por moeda, saques, campanhas de
anúncios com atribuição (CAC, ROAS, resultado) e um painel no estilo
Salro.

Nasceu para o experimento "30 dias pra primeira venda" (miniguia
"Chegada ao Japão sem perrengue", R$ 47, via Kiwify; Hotmart e Eduzz
também suportadas).

PWA standalone para iPhone (HTML/CSS/JS puros, sem build), tema
escuro premium Salro — Marinho `#091835`, Creme `#FBE5BF`, Cobre
`#CD9264`, Papel `#F7F3EA`, Tela `#1B2A4A`. Dados só no aparelho
(localStorage, prefixo `ven-`, chave única `ven-state`).

## Arquivos

| Arquivo | O quê |
|---|---|
| `index.html` | As 5 telas: Início (painel), Vendas, Anúncios, Despesas, Ajustes |
| `app.js` | Lógica + matemática pura em centavos (testável em Node) |
| `styles.css` | Tema Salro escuro |
| `sw.js` | Service worker network-first, cache `salro-vendas-v1-0` |
| `manifest.webmanifest` | Nome "Salro Vendas", tema `#091835` |
| `icon-180/192/512.png` | Ícones provisórios (marinho, barras creme, ponto cobre) |
| `test/test-vendas.js` | Harness Node: `node test/test-vendas.js` (88 asserções) |

## Regras da matemática

Tudo em **centavos inteiros** por dentro; os registros guardam os
valores como números na moeda (ex.: `gross: 47`).

- **Taxa da plataforma** = `round(bruto × % ÷ 100) + fixo`, por canal
  (config em Ajustes): Kiwify 8,99% + R$ 2,49 · Hotmart 9,9% +
  R$ 2,49 · Eduzz 4,9% + R$ 2,49 (plano Basic). A lista de canais é
  dirigida pela config (`DEFAULT_CONFIG.fees`): plataforma nova é
  uma entrada nova.
- **Líquido da plataforma** = bruto − taxa.
- **Reserva de imposto** = `round(líquido × taxPct ÷ 100)` —
  `taxPct` padrão 20%, editável. É uma reserva de planejamento, não
  um cálculo fiscal oficial.
- **Lucro líquido** = líquido − reserva.
- Referências (R$ 47, config padrão): Kiwify → taxa R$ 6,72,
  líquido R$ 40,28, reserva R$ 8,06, lucro R$ 32,22 · Hotmart →
  taxa R$ 7,14, líquido R$ 39,86 · Eduzz → taxa R$ 4,79, líquido
  R$ 42,21.
- **Despesas** são somadas **por moeda, nunca misturadas** (R$, ¥,
  US$ em totais separados).
- **Saques**: valor e taxa registrados por saque (taxa padrão
  R$ 3,67); recebido = sacado − taxas.
- As contas das vendas são recalculadas sempre com a config atual
  (mudar uma taxa em Ajustes reflete em todo o histórico).

## Importação do relatório da plataforma

Na aba **Vendas → Importar da plataforma**: escolha a plataforma,
suba o CSV exportado dela (ou cole o conteúdo — no iPhone, colar
costuma ser mais fácil) e toque em Importar. O app faz o resto:
breakdown, totais, reserva e lucro automáticos, e mostra o resumo
"X vendas importadas · Y duplicadas ignoradas · Z linhas puladas".

O parser é tolerante: delimitador `;` ou `,`, campos entre aspas,
BOM, CRLF. As colunas são reconhecidas por apelidos (caixa e acentos
ignorados):

| Campo | Cabeçalhos aceitos |
|---|---|
| Data | data, data da venda, data de criação, created, date |
| Produto | produto, product, nome do produto |
| Valor bruto | valor, preço, total, amount, valor da venda |
| Status | status, situação |
| Transação | transação, id, código, pedido, order |

- **Status**: havendo coluna de status, só entram vendas aprovadas
  (aprovada, completa, paga, approved, paid, complete…). Reembolso,
  cancelada e chargeback são pulados. Sem coluna de status, todas as
  linhas válidas entram.
- **Valores**: aceita `47,00`, `R$ 47,00`, `47.00`, `1.234,56`.
- **Datas**: aceita `dd/mm/yyyy`, `dd/mm/yyyy hh:mm`, `yyyy-mm-dd`.
- **Dedupe**: venda importada guarda o `txid` quando o relatório tem
  id de transação — reimportar pula por (canal + txid). Sem txid, o
  dedupe é pelo composto (canal + data + produto + bruto). Vendas
  manuais nunca são apagadas nem bloqueiam a importação.
- Vendas importadas começam **sem atribuição** de campanha.

> Os relatórios reais de cada plataforma variam de layout; os
> apelidos cobrem os cabeçalhos mais comuns. Se um relatório vier
> com um cabeçalho novo, basta acrescentá-lo em `CSV_ALIASES` no
> `app.js`.

## Campanhas e atribuição

Modelo `campanhas`: nome, produto, início, fim opcional, moeda do
gasto (R$/¥/US$), gasto e `rateToBRL` opcional (quanto 1 unidade da
moeda vale em R$ — ex.: 0,038 para ¥).

- Atribuição: no formulário de venda manual, o select de campanha
  lista só as campanhas **daquele produto**; em **Vendas → editar**
  dá para atribuir ou limpar a campanha de qualquer venda.
- Métricas por campanha (funções puras, testadas): vendas
  atribuídas, receita bruta, lucro atribuído, **CAC** = gasto ÷
  vendas, **ROAS** = receita ÷ gasto, **resultado** = lucro
  atribuído − gasto.
- Gasto em moeda estrangeira **sem** `rateToBRL`: aparece na moeda
  original e CAC/ROAS/resultado ficam indisponíveis (null) — nada é
  convertido com taxa inventada.

## Painel (Início)

KPIs (vendas, bruto, taxas, líquido, reserva, lucro, gasto em
anúncios em R$, lucro após anúncios), card do Experimento (meta:
primeira venda até 22/12/2026), barras de lucro líquido dos últimos
6 meses (toque revela o valor exato), cards **por produto** e **por
campanha**, e as últimas 5 vendas.

## Backup

Em Ajustes: exportar JSON (download + texto) e importar com
**merge por id** — junta vendas, despesas, saques e campanhas e
nunca apaga o que já existe. A config importada só substitui a
local se o backup trouxer uma.

## Como publicar (quando for a hora)

1. Ele cria o repositório **`salro-vendas`** no GitHub (público, como
   os outros apps da família).
2. Ele sobe os ícones oficiais pelo iPhone, se/quando houver arte
   final (os PNGs atuais são provisórios gerados por script).
3. A Muse empurra os arquivos de texto (`index.html`, `app.js`,
   `styles.css`, `sw.js`, `manifest.webmanifest`) para `main` **e**
   `gh-pages`, e confere os bytes ao vivo.
4. No iPhone: abrir a URL do GitHub Pages no Safari → Compartilhar →
   Adicionar à Tela de Início. Conferir o rodapé **"Salro Vendas ·
   versão 1.0"** no Início e nos Ajustes.

## Versão

`APP_VERSION = '1.0'` no `app.js` é a fonte única; o rodapé e o
cache do service worker (`salro-vendas-v1-0`) derivam dela — ao
mexer na versão, atualizar os dois juntos (o harness cobra isso).
