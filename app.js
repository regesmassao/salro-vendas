/* Salro Vendas — controle de lucro por venda de produtos digitais.

   Para cada venda, o app mostra a conta completa: bruto → taxa da
   plataforma → líquido da plataforma → reserva de imposto → lucro
   líquido. Despesas são somadas POR MOEDA (nunca misturadas) e os
   saques têm a taxa registrada à parte.

   Toda a matemática de dinheiro roda em CENTAVOS inteiros (funções
   puras, testáveis em Node — ver test/test-vendas.js). Os registros
   guardam os valores como números em reais (ex.: 47.5) e a conversão
   para centavos acontece dentro das funções de cálculo.

   Dados no aparelho (localStorage, prefixo ven-): uma única chave
   `ven-state` com {vendas, despesas, saques, campanhas, config}.
   Vendas podem ser atribuídas a uma campanha de anúncios
   (campaignId) para medir CAC, ROAS e lucro após anúncios. */
'use strict';

/* ============ Constantes ============ */
var APP_VERSION = '1.1';
var LS_KEY = 'ven-state';
var DEFAULT_PRODUCT = 'Miniguia — Chegada ao Japão sem perrengue';
var CHANNELS = { kiwify: 'Kiwify', hotmart: 'Hotmart', eduzz: 'Eduzz' };
var CURRENCIES = ['BRL', 'JPY', 'USD'];
var DEFAULT_CONFIG = {
  taxPct: 20,
  fees: {
    kiwify: { pct: 8.99, fixed: 2.49 },
    hotmart: { pct: 9.9, fixed: 2.49 },
    eduzz: { pct: 4.9, fixed: 2.49 }
  },
  saqueFee: 3.67
};
/* A lista de canais é dirigida pela config: uma plataforma nova é
   uma entrada em DEFAULT_CONFIG.fees (+ o rótulo em CHANNELS). */
var CHANNEL_KEYS = Object.keys(DEFAULT_CONFIG.fees);

/* ============ Utilidades puras ============ */
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function todayISO() {
  var t = new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}
function newId() {
  return 'ven-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function toCents(n) { return Math.round((Number(n) || 0) * 100); }
function groupThousands(intStr) {
  return String(intStr).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
/* Formata centavos como R$ 1.234,56. */
function fmtBRL(cents) {
  cents = Math.round(Number(cents) || 0);
  var neg = cents < 0; cents = Math.abs(cents);
  var s = groupThousands(Math.floor(cents / 100)) + ',' + pad2(cents % 100);
  return (neg ? '−R$ ' : 'R$ ') + s;
}
/* Ienes não têm centavos na exibição: ¥1.600. */
function fmtJPY(cents) {
  var yen = Math.round((Number(cents) || 0) / 100);
  var neg = yen < 0; yen = Math.abs(yen);
  return (neg ? '−¥' : '¥') + groupThousands(yen);
}
function fmtUSD(cents) {
  cents = Math.round(Number(cents) || 0);
  var neg = cents < 0; cents = Math.abs(cents);
  var s = groupThousands(Math.floor(cents / 100)) + ',' + pad2(cents % 100);
  return (neg ? '−US$ ' : 'US$ ') + s;
}
function fmtMoney(cents, currency) {
  if (currency === 'JPY') return fmtJPY(cents);
  if (currency === 'USD') return fmtUSD(cents);
  return fmtBRL(cents);
}
function fmtDateBR(iso) {
  if (!iso) return '—';
  var p = String(iso).split('-');
  if (p.length !== 3) return iso;
  return p[2] + '/' + p[1] + '/' + p[0];
}

/* ============ Matemática (pura, em centavos) ============ */
/* Taxa da plataforma: % sobre o bruto (arredondada ao centavo) + fixo. */
function feeFor(channel, grossCents, config) {
  var cfg = (config && config.fees && config.fees[channel]) ||
    DEFAULT_CONFIG.fees[channel] || DEFAULT_CONFIG.fees.kiwify;
  return Math.round(grossCents * (Number(cfg.pct) || 0) / 100) + toCents(cfg.fixed);
}
/* A conta completa de uma venda. Referências (config padrão):
   Kiwify R$ 47,00 → taxa 672, líquido 4028, reserva 806, lucro 3222.
   Hotmart R$ 47,00 → taxa 714, líquido 3986.
   Eduzz R$ 47,00 → taxa 479, líquido 4221. */
function saleBreakdown(venda, config) {
  var cfg = config || DEFAULT_CONFIG;
  var gross = toCents(venda && venda.gross);
  var fee = feeFor(venda && venda.channel, gross, cfg);
  var net = gross - fee;
  var reserva = Math.round(net * (Number(cfg.taxPct) || 0) / 100);
  return {
    gross: gross, fee: fee, netPlataforma: net,
    reserva: reserva, lucro: net - reserva
  };
}
function totals(vendas, config) {
  var t = { count: 0, gross: 0, fee: 0, netPlataforma: 0, reserva: 0, lucro: 0 };
  (vendas || []).forEach(function (v) {
    var b = saleBreakdown(v, config);
    t.count++;
    t.gross += b.gross; t.fee += b.fee; t.netPlataforma += b.netPlataforma;
    t.reserva += b.reserva; t.lucro += b.lucro;
  });
  return t;
}
/* Despesas somadas por moeda — NUNCA misturar moedas diferentes. */
function despesasByCurrency(despesas) {
  var out = { BRL: 0, JPY: 0, USD: 0 };
  (despesas || []).forEach(function (d) {
    var cur = CURRENCIES.indexOf(d.currency) >= 0 ? d.currency : 'BRL';
    out[cur] += toCents(d.amount);
  });
  return out;
}
function saquesTotals(saques) {
  var t = { count: 0, amount: 0, fees: 0, received: 0 };
  (saques || []).forEach(function (s) {
    t.count++;
    t.amount += toCents(s.amount);
    t.fees += toCents(s.fee);
  });
  t.received = t.amount - t.fees;
  return t;
}

/* ============ Campanhas de anúncios (puro) ============ */
/* Gasto da campanha convertido para centavos de R$: direto se a
   moeda for BRL; via rateToBRL (quanto 1 unidade vale em R$) quando
   houver taxa; null quando não dá para converter (ex.: campanha em
   ¥ sem taxa) — nesse caso CAC/ROAS/resultado ficam null e o gasto
   aparece só na moeda original. */
function campaignGastoBRL(campaign) {
  if (!campaign) return null;
  if (campaign.moeda === 'BRL') return toCents(campaign.gasto);
  if (typeof campaign.rateToBRL === 'number' && campaign.rateToBRL > 0) {
    return Math.round(campaign.gasto * campaign.rateToBRL * 100);
  }
  return null;
}
function campaignMetrics(campaign, vendas, config) {
  var attributed = (vendas || []).filter(function (v) {
    return v.campaignId && v.campaignId === campaign.id;
  });
  var receita = 0, lucro = 0;
  attributed.forEach(function (v) {
    var b = saleBreakdown(v, config);
    receita += b.gross;
    lucro += b.lucro;
  });
  var gastoBRL = campaignGastoBRL(campaign);
  return {
    numVendas: attributed.length,
    receitaBruta: receita,
    lucroAtribuido: lucro,
    gastoOriginalCents: toCents(campaign.gasto),
    gastoBRL: gastoBRL,
    cac: (gastoBRL != null && attributed.length > 0)
      ? Math.round(gastoBRL / attributed.length) : null,
    roas: (gastoBRL != null && gastoBRL > 0) ? receita / gastoBRL : null,
    resultado: (gastoBRL != null) ? lucro - gastoBRL : null
  };
}
/* Soma do gasto em anúncios já convertido (só campanhas com valor
   em R$ conhecido) — base do KPI "Gasto em anúncios" do painel. */
function adsTotalsBRL(campanhas) {
  var total = 0;
  (campanhas || []).forEach(function (c) {
    var g = campaignGastoBRL(c);
    if (g != null) total += g;
  });
  return total;
}
function unattributedCount(vendas) {
  return (vendas || []).filter(function (v) { return !v.campaignId; }).length;
}
/* Resumo por produto: vendas + conta completa + gasto em anúncios
   das campanhas daquele produto (conversível) + lucro após anúncios. */
function productSummaries(vendas, campanhas, config) {
  var byProduct = {};
  (vendas || []).forEach(function (v) {
    var p = byProduct[v.product];
    if (!p) {
      p = byProduct[v.product] = {
        product: v.product, count: 0, gross: 0, fee: 0,
        netPlataforma: 0, reserva: 0, lucro: 0, gastoAnuncios: 0, lucroAposAnuncios: 0
      };
    }
    var b = saleBreakdown(v, config);
    p.count++; p.gross += b.gross; p.fee += b.fee;
    p.netPlataforma += b.netPlataforma; p.reserva += b.reserva; p.lucro += b.lucro;
  });
  (campanhas || []).forEach(function (c) {
    var p = byProduct[c.produto];
    if (!p) return;
    var g = campaignGastoBRL(c);
    if (g != null) p.gastoAnuncios += g;
  });
  return Object.keys(byProduct).map(function (k) {
    var p = byProduct[k];
    p.lucroAposAnuncios = p.lucro - p.gastoAnuncios;
    return p;
  }).sort(function (a, b) { return b.gross - a.gross; });
}
/* Lucro líquido por mês (mês da venda), últimos `months` meses
   terminando no mês de refISO — para as barras do painel. */
function monthlyLucro(vendas, config, refISO, months) {
  var ref = validISODate(refISO) ? refISO : todayISO();
  var y = +ref.slice(0, 4), m = +ref.slice(5, 7);
  var out = [];
  var idx = {};
  for (var i = (months || 6) - 1; i >= 0; i--) {
    var d = new Date(y, m - 1 - i, 1);
    var key = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
    idx[key] = out.length;
    out.push({ month: key, lucro: 0, count: 0 });
  }
  (vendas || []).forEach(function (v) {
    var key = String(v.date || '').slice(0, 7);
    if (idx[key] === undefined) return;
    out[idx[key]].lucro += saleBreakdown(v, config).lucro;
    out[idx[key]].count++;
  });
  return out;
}

/* ============ Importação de relatório da plataforma (puro) ============
   O usuário exporta o relatório de vendas da plataforma (CSV) e o
   app faz o resto: reconhece as colunas por apelidos (sem acento,
   caixa baixa), só importa vendas aprovadas/completas quando há
   coluna de status, converte valores pt-BR e datas flexíveis, e
   deduplica por (canal + txid) ou, sem txid, por (canal + data +
   produto + bruto). Vendas manuais nunca são removidas nem bloqueiam
   a importação. */
var CSV_ALIASES = {
  date: ['data', 'data da venda', 'data de criacao', 'created', 'date', 'data do pedido'],
  product: ['produto', 'product', 'nome do produto', 'item'],
  gross: ['valor', 'preco', 'total', 'amount', 'valor da venda', 'valor bruto', 'preco de venda'],
  status: ['status', 'situacao', 'situacao da venda', 'status da venda'],
  txid: ['transacao', 'id', 'codigo', 'pedido', 'order', 'id da transacao', 'codigo da transacao', 'numero do pedido']
};
var STATUS_APPROVED = ['aprovada', 'aprovado', 'completa', 'completo', 'paga', 'pago',
  'approved', 'paid', 'complete', 'completed', 'aprovada/completa', 'concluida', 'concluido'];

function normalizeHeader(s) {
  return String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}
/* Parser CSV tolerante: delimitador ; ou , (detectado no cabeçalho),
   campos entre aspas (com "" escapado), BOM e CRLF. */
function parseCSV(text) {
  var s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  var firstLine = s.split(/\r\n|\r|\n/, 1)[0] || '';
  var delim = firstLine.indexOf(';') >= 0 ? ';' : ',';
  var rows = [], row = [], field = '', inQuotes = false, i, ch;
  function endField() { row.push(field); field = ''; }
  function endRow() { endField(); rows.push(row); row = []; }
  for (i = 0; i < s.length; i++) {
    ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      /* CRLF: o \n seguinte fecha a linha; \r sozinho também fecha */
      if (s[i + 1] !== '\n') endRow();
    } else field += ch;
  }
  if (field.length || row.length) endRow();
  return rows.filter(function (r) {
    return r.some(function (c) { return String(c).trim() !== ''; });
  });
}
/* "47,00" | "R$ 47,00" | "47.00" | "1.234,56" → centavos (ou null). */
function parseGrossToCents(raw) {
  if (raw == null) return null;
  var s = String(raw).replace(/R\$\s*/gi, '').replace(/\s+/g, '').trim();
  if (!s) return null;
  if (s.indexOf('.') >= 0 && s.indexOf(',') >= 0) {
    s = s.replace(/\./g, '').replace(',', '.'); /* 1.234,56 → 1234.56 */
  } else if (s.indexOf(',') >= 0) {
    s = s.replace(',', '.');
  }
  var v = parseFloat(s);
  if (!isFinite(v) || v <= 0) return null;
  return Math.round(v * 100);
}
/* dd/mm/yyyy | dd/mm/yyyy hh:mm | yyyy-mm-dd → ISO (ou null). */
function parseDateFlex(raw) {
  if (raw == null) return null;
  var s = String(raw).trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) {
    var d = +m[1], mo = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return m[3] + '-' + pad2(mo) + '-' + pad2(d);
  }
  return null;
}
function matchColumns(headerRow) {
  var norm = headerRow.map(normalizeHeader);
  var cols = {};
  Object.keys(CSV_ALIASES).forEach(function (key) {
    cols[key] = -1;
    for (var i = 0; i < norm.length; i++) {
      if (CSV_ALIASES[key].indexOf(norm[i]) >= 0) { cols[key] = i; break; }
    }
  });
  return cols;
}
function dedupeKeyTxid(channel, txid) { return channel + '|tx|' + txid; }
function dedupeKeyComposite(channel, date, product, grossCents) {
  return channel + '|cp|' + date + '|' + normalizeHeader(product) + '|' + grossCents;
}
/* Importa as vendas de um CSV de UM canal. Devolve as vendas novas
   (já higienizadas, origin 'import') e os contadores do resumo. */
function importSalesFromCSV(text, channel, existingVendas) {
  var result = { vendas: [], imported: 0, duplicates: 0, skipped: 0 };
  var rows = parseCSV(text);
  if (!rows.length) return result;
  var cols = matchColumns(rows[0]);
  if (cols.gross < 0) { result.skipped = Math.max(0, rows.length - 1); return result; }
  var seen = {};
  (existingVendas || []).forEach(function (v) {
    if (v.txid) seen[dedupeKeyTxid(v.channel, v.txid)] = true;
    if (v.origin === 'import') {
      seen[dedupeKeyComposite(v.channel, v.date, v.product, toCents(v.gross))] = true;
    }
  });
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    function cell(idx) { return idx >= 0 && idx < row.length ? String(row[idx]).trim() : ''; }
    if (cols.status >= 0) {
      var st = normalizeHeader(cell(cols.status));
      if (STATUS_APPROVED.indexOf(st) < 0) { result.skipped++; continue; }
    }
    var grossCents = parseGrossToCents(cell(cols.gross));
    var date = cols.date >= 0 ? parseDateFlex(cell(cols.date)) : todayISO();
    if (grossCents == null || !date) { result.skipped++; continue; }
    var product = cols.product >= 0 ? cell(cols.product) : '';
    var txid = cols.txid >= 0 ? cell(cols.txid) : '';
    var key = txid ? dedupeKeyTxid(channel, txid)
      : dedupeKeyComposite(channel, date, product || DEFAULT_PRODUCT, grossCents);
    if (seen[key]) { result.duplicates++; continue; }
    seen[key] = true;
    var venda = sanitizeVenda({
      id: newId(),
      date: date,
      product: product || DEFAULT_PRODUCT,
      channel: channel,
      gross: grossCents / 100,
      txid: txid || null,
      origin: 'import'
    });
    if (!venda) { result.skipped++; continue; }
    result.vendas.push(venda);
    result.imported++;
  }
  return result;
}

/* ============ Higienização / estado ============ */
function sanitizeConfig(raw) {
  var c = (raw && typeof raw === 'object') ? raw : {};
  var fees = (c.fees && typeof c.fees === 'object') ? c.fees : {};
  function feeOf(ch) {
    var f = (fees[ch] && typeof fees[ch] === 'object') ? fees[ch] : {};
    var d = DEFAULT_CONFIG.fees[ch];
    return {
      pct: (typeof f.pct === 'number' && isFinite(f.pct)) ? f.pct : d.pct,
      fixed: (typeof f.fixed === 'number' && isFinite(f.fixed)) ? round2(f.fixed) : d.fixed
    };
  }
  var feesOut = {};
  CHANNEL_KEYS.forEach(function (ch) { feesOut[ch] = feeOf(ch); });
  return {
    taxPct: (typeof c.taxPct === 'number' && isFinite(c.taxPct) && c.taxPct >= 0 && c.taxPct <= 100)
      ? c.taxPct : DEFAULT_CONFIG.taxPct,
    fees: feesOut,
    saqueFee: (typeof c.saqueFee === 'number' && isFinite(c.saqueFee) && c.saqueFee >= 0)
      ? round2(c.saqueFee) : DEFAULT_CONFIG.saqueFee
  };
}
function validISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function sanitizeVenda(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  var gross = Number(raw.gross);
  if (!isFinite(gross) || gross <= 0) return null;
  return {
    id: raw.id,
    date: validISODate(raw.date) ? raw.date : todayISO(),
    product: typeof raw.product === 'string' && raw.product ? raw.product : DEFAULT_PRODUCT,
    channel: CHANNELS[raw.channel] ? raw.channel : 'kiwify',
    gross: round2(gross),
    /* txid: id da transação no relatório da plataforma (null em
       venda manual). origin: 'manual' | 'import' — base do dedupe.
       campaignId: campanha de anúncios à qual a venda é atribuída
       (null = sem atribuição; importadas começam sem atribuição). */
    txid: (typeof raw.txid === 'string' && raw.txid.trim()) ? raw.txid.trim() : null,
    origin: raw.origin === 'import' ? 'import' : 'manual',
    campaignId: (typeof raw.campaignId === 'string' && raw.campaignId) ? raw.campaignId : null
  };
}
function sanitizeDespesa(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  var amount = Number(raw.amount);
  if (!isFinite(amount) || amount === 0) return null;
  return {
    id: raw.id,
    date: validISODate(raw.date) ? raw.date : todayISO(),
    desc: typeof raw.desc === 'string' ? raw.desc : '',
    currency: CURRENCIES.indexOf(raw.currency) >= 0 ? raw.currency : 'BRL',
    amount: round2(amount)
  };
}
function sanitizeSaque(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  var amount = Number(raw.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  var fee = Number(raw.fee);
  return {
    id: raw.id,
    date: validISODate(raw.date) ? raw.date : todayISO(),
    amount: round2(amount),
    fee: isFinite(fee) && fee >= 0 ? round2(fee) : 0
  };
}
function sanitizeCampanha(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  var gasto = Number(raw.gasto);
  if (!isFinite(gasto) || gasto < 0) return null;
  var rate = (raw.rateToBRL == null) ? null : Number(raw.rateToBRL);
  return {
    id: raw.id,
    nome: typeof raw.nome === 'string' && raw.nome ? raw.nome : 'Campanha',
    produto: typeof raw.produto === 'string' && raw.produto ? raw.produto : DEFAULT_PRODUCT,
    inicio: validISODate(raw.inicio) ? raw.inicio : todayISO(),
    fim: validISODate(raw.fim) ? raw.fim : null,
    moeda: CURRENCIES.indexOf(raw.moeda) >= 0 ? raw.moeda : 'BRL',
    gasto: round2(gasto),
    rateToBRL: (rate != null && isFinite(rate) && rate > 0) ? rate : null
  };
}
function sanitizeState(raw) {
  var s = (raw && typeof raw === 'object') ? raw : {};
  function list(arr, fn) {
    return Array.isArray(arr) ? arr.map(fn).filter(Boolean) : [];
  }
  return {
    vendas: list(s.vendas, sanitizeVenda),
    despesas: list(s.despesas, sanitizeDespesa),
    saques: list(s.saques, sanitizeSaque),
    campanhas: list(s.campanhas, sanitizeCampanha),
    config: sanitizeConfig(s.config)
  };
}
/* Aceita o payload de backup ({app, version, exportedAt, data}) ou o
   estado puro. */
function extractState(raw) {
  if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' &&
      (Array.isArray(raw.data.vendas) || Array.isArray(raw.data.despesas) ||
       Array.isArray(raw.data.saques) || Array.isArray(raw.data.campanhas) || raw.data.config)) {
    return raw.data;
  }
  return raw;
}
/* Resumo que a Salro Central exibe: calculado pelo próprio app, com
   a matemática de breakdown (centavos inteiros). vendasMes conta só
   as vendas cuja data cai no mês de referência; totais conta todas. */
function resumoShape(t) {
  return {
    qtd: t.count, bruto: t.gross, liquido: t.netPlataforma,
    reserva: t.reserva, lucro: t.lucro
  };
}
function buildResumo(state, refISO) {
  var s = sanitizeState(state);
  var ref = validISODate(refISO) ? refISO : todayISO();
  var mes = ref.slice(0, 7);
  var doMes = s.vendas.filter(function (v) {
    return String(v.date || '').slice(0, 7) === mes;
  });
  return {
    mes: mes,
    vendasMes: resumoShape(totals(doMes, s.config)),
    totais: resumoShape(totals(s.vendas, s.config))
  };
}
function buildBackupPayload(state) {
  var s = sanitizeState(state);
  var data = {
    vendas: s.vendas, despesas: s.despesas, saques: s.saques,
    campanhas: s.campanhas, config: s.config,
    resumo: buildResumo(s)
  };
  return {
    app: 'salro-vendas',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: data
  };
}
/* Junta por id (nunca apaga): item importado com id já existente
   substitui o local; os demais são acrescentados. A config importada
   só substitui a local se o backup trouxer uma. */
function mergeImport(existing, incomingRaw) {
  var cur = sanitizeState(existing);
  var incRaw = extractState(incomingRaw);
  var inc = sanitizeState(incRaw);
  var added = 0, updated = 0;
  function mergeList(curList, incList) {
    var byId = {};
    curList.forEach(function (it) { byId[it.id] = it; });
    incList.forEach(function (it) {
      if (byId[it.id]) updated++; else added++;
      byId[it.id] = it;
    });
    return Object.keys(byId).map(function (k) { return byId[k]; });
  }
  var hasConfig = !!(incRaw && typeof incRaw === 'object' && incRaw.config);
  return {
    state: {
      vendas: mergeList(cur.vendas, inc.vendas),
      despesas: mergeList(cur.despesas, inc.despesas),
      saques: mergeList(cur.saques, inc.saques),
      campanhas: mergeList(cur.campanhas, inc.campanhas),
      config: hasConfig ? inc.config : cur.config
    },
    added: added, updated: updated
  };
}

/* Junção da NUVEM — semântica diferente do mergeImport de arquivo:
   item da nuvem com id novo entra; id já existente mantém a versão
   LOCAL; nada é apagado; a config fica a local (é preferência do
   aparelho, não dado). */
function mergeCloudDownload(existing, incomingRaw) {
  var cur = sanitizeState(existing);
  var inc = sanitizeState(extractState(incomingRaw));
  var added = 0;
  function addOnly(curList, incList) {
    var ids = {};
    curList.forEach(function (it) { ids[it.id] = true; });
    var out = curList.slice();
    incList.forEach(function (it) {
      if (!ids[it.id]) { out.push(it); ids[it.id] = true; added++; }
    });
    return out;
  }
  return {
    state: {
      vendas: addOnly(cur.vendas, inc.vendas),
      despesas: addOnly(cur.despesas, inc.despesas),
      saques: addOnly(cur.saques, inc.saques),
      campanhas: addOnly(cur.campanhas, inc.campanhas),
      config: cur.config
    },
    added: added
  };
}
/* Trava de segurança do envio: nunca sobrescrever em silêncio um
   backup da nuvem com MAIS vendas por um aparelho com MENOS. */
function shouldBlockUpload(localCount, remoteCount) {
  return (Number(remoteCount) || 0) > (Number(localCount) || 0);
}
var state = sanitizeState(null);
function loadState() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) return sanitizeState(JSON.parse(raw));
  } catch (e) { /* estado ilegível → começa do padrão */ }
  return sanitizeState(null);
}
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ============ Interface (navegador) ============ */
function $(id) { return document.getElementById(id); }

function sortedByDateDesc(list) {
  return list.slice().sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

var selectedBarMonth = null; /* mês tocado nas barras do painel */
var editingVendaId = null;   /* venda em edição no formulário */

function campaignName(id) {
  var c = state.campanhas.filter(function (x) { return x.id === id; })[0];
  return c ? c.nome : '';
}

function renderHome() {
  var cfg = state.config;
  var t = totals(state.vendas, cfg);
  var adsBRL = adsTotalsBRL(state.campanhas);
  $('kpiVendasCount').textContent = t.count;
  $('kpiVendasGross').textContent = fmtBRL(t.gross);
  $('kpiTaxas').textContent = fmtBRL(t.fee);
  $('kpiLiquido').textContent = fmtBRL(t.netPlataforma);
  $('kpiReservaPct').textContent = 'Reserva de imposto (' + cfg.taxPct + '%)';
  $('kpiReserva').textContent = fmtBRL(t.reserva);
  $('kpiLucro').textContent = fmtBRL(t.lucro);
  $('kpiAds').textContent = fmtBRL(adsBRL);
  $('kpiLucroApos').textContent = fmtBRL(t.lucro - adsBRL);
  $('expCount').textContent = t.count === 1
    ? '1 venda registrada' : t.count + ' vendas registradas';

  /* Por produto */
  var prods = productSummaries(state.vendas, state.campanhas, cfg);
  $('byProduct').innerHTML = prods.length ? prods.map(function (p) {
    return '<div class="card subcard"><div class="cardtitle">' + esc(p.product) + '</div>' +
      '<div class="grid2">' +
      miniKPI(p.count + '', 'vendas') + miniKPI(fmtBRL(p.gross), 'bruto') +
      miniKPI(fmtBRL(p.netPlataforma), 'líquido plataforma') + miniKPI(fmtBRL(p.reserva), 'reserva') +
      miniKPI(fmtBRL(p.lucro), 'lucro líquido') + miniKPI(fmtBRL(p.gastoAnuncios), 'gasto em anúncios') +
      '</div><div class="highlight">Lucro após anúncios: <strong>' + fmtBRL(p.lucroAposAnuncios) + '</strong></div></div>';
  }).join('') : '<p class="muted">Nenhum produto com vendas ainda.</p>';

  /* Por campanha (maiores gastos primeiro; sem conversão vão por último) */
  var camps = state.campanhas.map(function (c) {
    return { c: c, m: campaignMetrics(c, state.vendas, cfg) };
  }).sort(function (a, b) {
    var ga = a.m.gastoBRL == null ? -1 : a.m.gastoBRL;
    var gb = b.m.gastoBRL == null ? -1 : b.m.gastoBRL;
    return gb - ga;
  }).slice(0, 3);
  $('byCampaign').innerHTML = camps.length ? camps.map(function (x) {
    return campaignCardHTML(x.c, x.m);
  }).join('') : '<p class="muted">Nenhuma campanha ainda. Crie na aba Anúncios.</p>';

  /* Barras: lucro líquido dos últimos 6 meses (toca para ver o valor) */
  var months = monthlyLucro(state.vendas, cfg, todayISO(), 6);
  var maxAbs = 0;
  months.forEach(function (mo) { maxAbs = Math.max(maxAbs, Math.abs(mo.lucro)); });
  $('monthBars').innerHTML = months.map(function (mo) {
    var h = maxAbs > 0 ? Math.max(4, Math.round(Math.abs(mo.lucro) / maxAbs * 100)) : 4;
    var sel = selectedBarMonth === mo.month;
    return '<div class="barcol' + (sel ? ' on' : '') + '" data-bar-month="' + mo.month + '">' +
      '<div class="barvalue">' + (sel ? fmtBRL(mo.lucro) : '') + '</div>' +
      '<div class="bar' + (mo.lucro < 0 ? ' neg' : '') + '" style="height:' + h + '%"></div>' +
      '<div class="barlabel">' + mo.month.slice(5) + '/' + mo.month.slice(2, 4) + '</div></div>';
  }).join('');

  var last = sortedByDateDesc(state.vendas).slice(0, 5);
  $('lastSales').innerHTML = last.length ? last.map(function (v) {
    return saleRowHTML(v, false);
  }).join('') : '<p class="muted">Nenhuma venda ainda. Quando a primeira sair, ela aparece aqui.</p>';
}

function miniKPI(value, label) {
  return '<div class="minikpi"><div class="minikpi-value">' + esc(value) + '</div>' +
    '<div class="minikpi-label">' + esc(label) + '</div></div>';
}

function campaignCardHTML(c, m) {
  var gastoTxt = fmtMoney(m.gastoOriginalCents, c.moeda) +
    (m.gastoBRL != null && c.moeda !== 'BRL' ? ' (≈ ' + fmtBRL(m.gastoBRL) + ')' : '');
  var period = fmtDateBR(c.inicio) + (c.fim ? ' → ' + fmtDateBR(c.fim) : ' → …');
  return '<div class="card subcard"><div class="cardtitle">✦ ' + esc(c.nome) + '</div>' +
    '<div class="rowsub">' + esc(c.produto) + ' · ' + period + '</div>' +
    '<div class="grid2">' +
    miniKPI(gastoTxt, 'gasto') +
    miniKPI(m.numVendas + '', 'vendas atribuídas') +
    miniKPI(fmtBRL(m.receitaBruta), 'receita') +
    miniKPI(m.cac != null ? fmtBRL(m.cac) : '—', 'CAC') +
    miniKPI(m.roas != null ? m.roas.toFixed(2).replace('.', ',') + '×' : '—', 'ROAS') +
    miniKPI(m.resultado != null ? fmtBRL(m.resultado) : '—', 'resultado (lucro − gasto)') +
    '</div>' +
    (m.gastoBRL == null ? '<p class="muted">Sem taxa de conversão para R$ — CAC, ROAS e resultado ficam indisponíveis; o gasto aparece na moeda original.</p>' : '') +
    '</div>';
}

function renderAnuncios() {
  $('unattributedLine').textContent = 'Vendas sem atribuição: ' + unattributedCount(state.vendas);
  var list = state.campanhas.slice().sort(function (a, b) {
    return a.inicio < b.inicio ? 1 : -1;
  });
  $('campaignList').innerHTML = list.length ? list.map(function (c) {
    var m = campaignMetrics(c, state.vendas, state.config);
    return campaignCardHTML(c, m) +
      '<div class="rowactions"><button class="del" type="button" data-del-campanha="' + esc(c.id) + '">apagar campanha</button></div>';
  }).join('') : '<p class="muted">Nenhuma campanha registrada.</p>';
}

function saleRowHTML(v, withDelete) {
  var b = saleBreakdown(v, state.config);
  return '<div class="rowitem">' +
    '<div class="rowmain">' +
      '<div class="rowtitle">' + esc(v.product) + '</div>' +
      '<div class="rowsub">' + fmtDateBR(v.date) + ' · ' + esc(CHANNELS[v.channel] || v.channel) +
        (v.origin === 'import' ? ' · importada' : '') +
        (v.campaignId ? ' · ✦ ' + esc(campaignName(v.campaignId)) : '') + '</div>' +
      '<div class="rowmath">' + fmtBRL(b.gross) + ' → líquido ' + fmtBRL(b.netPlataforma) +
        ' → lucro ' + fmtBRL(b.lucro) + '</div>' +
    '</div>' +
    '<div class="rowside"><div class="rowvalue">' + fmtBRL(b.lucro) + '</div>' +
    (withDelete ? '<button class="del" type="button" data-edit-venda="' + esc(v.id) + '">editar</button>' +
      '<button class="del" type="button" data-del-venda="' + esc(v.id) + '">apagar</button>' : '') +
    '</div></div>';
}

function renderVendas() {
  var list = sortedByDateDesc(state.vendas);
  $('salesList').innerHTML = list.length ? list.map(function (v) {
    return saleRowHTML(v, true);
  }).join('') : '<p class="muted">Nenhuma venda registrada.</p>';
}

function renderDespesas() {
  var list = sortedByDateDesc(state.despesas);
  $('expList').innerHTML = list.length ? list.map(function (d) {
    return '<div class="rowitem"><div class="rowmain">' +
      '<div class="rowtitle">' + esc(d.desc || 'Despesa') + '</div>' +
      '<div class="rowsub">' + fmtDateBR(d.date) + '</div></div>' +
      '<div class="rowside"><div class="rowvalue">' + fmtMoney(toCents(d.amount), d.currency) + '</div>' +
      '<button class="del" type="button" data-del-despesa="' + esc(d.id) + '">apagar</button></div></div>';
  }).join('') : '<p class="muted">Nenhuma despesa registrada.</p>';
  var by = despesasByCurrency(state.despesas);
  $('expTotals').innerHTML = CURRENCIES.map(function (cur) {
    return '<div class="minikpi"><div class="minikpi-value">' + fmtMoney(by[cur], cur) + '</div>' +
      '<div class="minikpi-label">total em ' + (cur === 'BRL' ? 'R$' : cur === 'JPY' ? '¥' : 'US$') + '</div></div>';
  }).join('');
  var sl = sortedByDateDesc(state.saques);
  $('saqueList').innerHTML = sl.length ? sl.map(function (s) {
    return '<div class="rowitem"><div class="rowmain">' +
      '<div class="rowtitle">Saque de ' + fmtBRL(toCents(s.amount)) + '</div>' +
      '<div class="rowsub">' + fmtDateBR(s.date) + ' · taxa ' + fmtBRL(toCents(s.fee)) +
      ' · recebido ' + fmtBRL(toCents(s.amount) - toCents(s.fee)) + '</div></div>' +
      '<div class="rowside"><button class="del" type="button" data-del-saque="' + esc(s.id) + '">apagar</button></div></div>';
  }).join('') : '<p class="muted">Nenhum saque registrado.</p>';
  var st = saquesTotals(state.saques);
  $('saqueTotals').innerHTML =
    '<div class="minikpi"><div class="minikpi-value">' + fmtBRL(st.amount) + '</div><div class="minikpi-label">total sacado</div></div>' +
    '<div class="minikpi"><div class="minikpi-value">' + fmtBRL(st.fees) + '</div><div class="minikpi-label">em taxas de saque</div></div>' +
    '<div class="minikpi"><div class="minikpi-value">' + fmtBRL(st.received) + '</div><div class="minikpi-label">recebido</div></div>';
}

function fillConfigForm() {
  var c = state.config;
  $('cTaxPct').value = c.taxPct;
  $('cKiwifyPct').value = c.fees.kiwify.pct;
  $('cKiwifyFixed').value = c.fees.kiwify.fixed;
  $('cHotmartPct').value = c.fees.hotmart.pct;
  $('cHotmartFixed').value = c.fees.hotmart.fixed;
  $('cEduzzPct').value = c.fees.eduzz.pct;
  $('cEduzzFixed').value = c.fees.eduzz.fixed;
  $('cSaqueFee').value = c.saqueFee;
}

function renderAll() {
  renderHome();
  renderVendas();
  renderAnuncios();
  renderDespesas();
  refreshCampaignOptions();
  renderVersionFooter();
}

function showView(name) {
  ['home', 'vendas', 'anuncios', 'despesas', 'ajustes'].forEach(function (v) {
    $('view-' + v).classList.toggle('hidden', v !== name);
    $('tab-' + v).classList.toggle('on', v === name);
  });
  window.scrollTo(0, 0);
}

/* Select de campanhas do formulário de venda: só campanhas cujo
   produto bate com o produto escolhido/digitado. */
function refreshCampaignOptions(keepId) {
  var sel = $('vCampaign');
  if (!sel) return;
  var current = keepId !== undefined ? keepId : sel.value;
  var product = $('vProduct').value.trim();
  var opts = state.campanhas.filter(function (c) { return c.produto === product; });
  sel.innerHTML = '<option value="">Sem campanha</option>' + opts.map(function (c) {
    return '<option value="' + esc(c.id) + '">' + esc(c.nome) + '</option>';
  }).join('');
  sel.value = opts.some(function (c) { return c.id === current; }) ? current : '';
}

function startEditVenda(v) {
  editingVendaId = v.id;
  $('vDate').value = v.date;
  $('vProduct').value = v.product;
  $('vChannel').value = v.channel;
  $('vGross').value = v.gross;
  refreshCampaignOptions(v.campaignId || '');
  $('btnAddVenda').textContent = 'Salvar alterações';
  $('editNote').classList.remove('hidden');
  showView('vendas');
  window.scrollTo(0, 0);
}
function cancelEditVenda() {
  editingVendaId = null;
  $('btnAddVenda').textContent = 'Adicionar venda';
  $('editNote').classList.add('hidden');
  $('vProduct').value = DEFAULT_PRODUCT;
  $('vGross').value = 47;
  refreshCampaignOptions('');
}

function numVal(id) {
  var v = parseFloat(String($(id).value).replace(',', '.'));
  return isFinite(v) ? v : NaN;
}

function bindEvents() {
  ['home', 'vendas', 'anuncios', 'despesas', 'ajustes'].forEach(function (v) {
    $('tab-' + v).addEventListener('click', function () { showView(v); });
  });

  $('vDate').value = todayISO();
  $('vProduct').value = DEFAULT_PRODUCT;
  $('vGross').value = 47;
  $('vProduct').addEventListener('input', function () { refreshCampaignOptions(); });
  $('btnCancelEdit').addEventListener('click', function () { cancelEditVenda(); });
  $('btnAddVenda').addEventListener('click', function () {
    var gross = numVal('vGross');
    if (!isFinite(gross) || gross <= 0) { alert('Informe o valor bruto da venda.'); return; }
    var fields = {
      date: $('vDate').value || todayISO(),
      product: $('vProduct').value.trim() || DEFAULT_PRODUCT,
      channel: $('vChannel').value,
      gross: gross,
      campaignId: $('vCampaign').value || null
    };
    if (editingVendaId) {
      state.vendas = state.vendas.map(function (v) {
        if (v.id !== editingVendaId) return v;
        return sanitizeVenda(Object.assign({}, v, fields));
      });
      cancelEditVenda();
    } else {
      state.vendas.push(sanitizeVenda(Object.assign({
        id: newId(), txid: null, origin: 'manual'
      }, fields)));
      $('vGross').value = 47;
      refreshCampaignOptions();
    }
    saveState(); renderAll();
  });

  /* Campanhas */
  $('aInicio').value = todayISO();
  $('aProduto').value = DEFAULT_PRODUCT;
  $('btnAddCampanha').addEventListener('click', function () {
    var gasto = numVal('aGasto');
    if (!isFinite(gasto) || gasto < 0) { alert('Informe o gasto da campanha (pode ser 0).'); return; }
    var rate = numVal('aRate');
    state.campanhas.push(sanitizeCampanha({
      id: newId(),
      nome: $('aNome').value.trim() || 'Campanha',
      produto: $('aProduto').value.trim() || DEFAULT_PRODUCT,
      inicio: $('aInicio').value || todayISO(),
      fim: $('aFim').value || null,
      moeda: $('aMoeda').value,
      gasto: gasto,
      rateToBRL: isFinite(rate) && rate > 0 ? rate : null
    }));
    saveState(); renderAll();
    $('aNome').value = ''; $('aGasto').value = ''; $('aRate').value = ''; $('aFim').value = '';
  });

  /* Importação do relatório da plataforma (CSV) */
  $('impFile').addEventListener('change', function () {
    var f = $('impFile').files && $('impFile').files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { $('impText').value = String(reader.result || ''); };
    reader.readAsText(f);
  });
  $('btnImportSales').addEventListener('click', function () {
    var text = $('impText').value;
    if (!text.trim()) { alert('Escolha o arquivo CSV do relatório ou cole o conteúdo dele.'); return; }
    var res = importSalesFromCSV(text, $('impChannel').value, state.vendas);
    if (res.imported > 0) {
      state.vendas = state.vendas.concat(res.vendas);
      saveState(); renderAll();
    }
    $('impResult').textContent = res.imported + ' vendas importadas · ' +
      res.duplicates + ' duplicadas ignoradas · ' + res.skipped + ' linhas puladas';
  });

  $('dDate').value = todayISO();
  $('btnAddDespesa').addEventListener('click', function () {
    var amount = numVal('dAmount');
    if (!isFinite(amount) || amount === 0) { alert('Informe o valor da despesa.'); return; }
    state.despesas.push(sanitizeDespesa({
      id: newId(),
      date: $('dDate').value || todayISO(),
      desc: $('dDesc').value.trim(),
      currency: $('dCurrency').value,
      amount: amount
    }));
    saveState(); renderAll();
    $('dDesc').value = ''; $('dAmount').value = '';
  });

  $('sDate').value = todayISO();
  $('sFee').value = state.config.saqueFee;
  $('btnAddSaque').addEventListener('click', function () {
    var amount = numVal('sAmount');
    var fee = numVal('sFee');
    if (!isFinite(amount) || amount <= 0) { alert('Informe o valor do saque.'); return; }
    state.saques.push(sanitizeSaque({
      id: newId(),
      date: $('sDate').value || todayISO(),
      amount: amount,
      fee: isFinite(fee) && fee >= 0 ? fee : state.config.saqueFee
    }));
    saveState(); renderAll();
    $('sAmount').value = '';
  });

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var bar = t.getAttribute('data-bar-month') ||
      (t.parentNode && t.parentNode.getAttribute ? t.parentNode.getAttribute('data-bar-month') : null);
    if (bar) {
      selectedBarMonth = selectedBarMonth === bar ? null : bar;
      renderHome();
      return;
    }
    var edv = t.getAttribute('data-edit-venda');
    if (edv) {
      var v = state.vendas.filter(function (x) { return x.id === edv; })[0];
      if (v) startEditVenda(v);
      return;
    }
    var dv = t.getAttribute('data-del-venda');
    var dd = t.getAttribute('data-del-despesa');
    var ds = t.getAttribute('data-del-saque');
    var dc = t.getAttribute('data-del-campanha');
    if (dv) {
      state.vendas = state.vendas.filter(function (v) { return v.id !== dv; });
      if (editingVendaId === dv) cancelEditVenda();
    }
    else if (dd) state.despesas = state.despesas.filter(function (d) { return d.id !== dd; });
    else if (ds) state.saques = state.saques.filter(function (s) { return s.id !== ds; });
    else if (dc) {
      state.campanhas = state.campanhas.filter(function (c) { return c.id !== dc; });
      state.vendas = state.vendas.map(function (v) {
        return v.campaignId === dc ? Object.assign({}, v, { campaignId: null }) : v;
      });
    }
    else return;
    saveState(); renderAll();
  });

  $('btnSaveConfig').addEventListener('click', function () {
    var taxPct = numVal('cTaxPct');
    state.config = sanitizeConfig({
      taxPct: isFinite(taxPct) ? taxPct : state.config.taxPct,
      fees: {
        kiwify: { pct: numVal('cKiwifyPct'), fixed: numVal('cKiwifyFixed') },
        hotmart: { pct: numVal('cHotmartPct'), fixed: numVal('cHotmartFixed') },
        eduzz: { pct: numVal('cEduzzPct'), fixed: numVal('cEduzzFixed') }
      },
      saqueFee: numVal('cSaqueFee')
    });
    saveState(); fillConfigForm();
    $('sFee').value = state.config.saqueFee;
    renderAll();
    alert('Ajustes salvos. As contas das vendas usam os valores novos.');
  });

  $('btnExport').addEventListener('click', function () {
    var text = JSON.stringify(buildBackupPayload(state), null, 1);
    $('backupText').value = text;
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'salro-vendas-backup.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 400);
  });
  $('backupFile').addEventListener('change', function () {
    var f = $('backupFile').files && $('backupFile').files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { $('backupText').value = String(reader.result || ''); };
    reader.readAsText(f);
  });
  $('btnImport').addEventListener('click', function () {
    var parsed;
    try { parsed = JSON.parse($('backupText').value); }
    catch (e) { alert('O texto não é um backup válido.'); return; }
    var res = mergeImport(state, parsed);
    state = res.state;
    saveState(); fillConfigForm(); renderAll();
    alert('Importação concluída: ' + res.added + ' novo(s), ' + res.updated + ' atualizado(s). Nada foi apagado.');
  });

  /* Nuvem (Google Drive) */
  $('driveSave').addEventListener('click', function () { driveSaveConfig(); });
  $('driveUp').addEventListener('click', function () { driveUpload(false); });
  $('driveUpForce').addEventListener('click', function () { driveUpload(true); });
  $('driveDown').addEventListener('click', function () { driveDownload(); });
}

/* ============ Nuvem (Google Drive) ============ */
/* Mesma ponte dos outros apps Salro: um Apps Script na conta Google
   dele guarda UM arquivo de backup no Drive (salro-vendas-nuvem.json).
   GET ?key=&action=read devolve {ok, exists, updatedAt, data};
   POST ?key=&action=write (corpo = o JSON do backup, como texto puro,
   pra não disparar preflight de CORS) devolve {ok, updatedAt}.
   Link e chave ficam salvos só neste aparelho (ven-driveUrl/
   ven-driveKey, chaves separadas do ven-state) — NUNCA entram no
   payload do backup. */
function driveConfig() {
  return {
    url: String(localStorage.getItem('ven-driveUrl') || '').trim(),
    key: String(localStorage.getItem('ven-driveKey') || '').trim()
  };
}
function driveApiUrl(action) {
  var c = driveConfig();
  var sep = c.url.indexOf('?') >= 0 ? '&' : '?';
  return c.url + sep + 'key=' + encodeURIComponent(c.key) + '&action=' + action;
}
function driveSetStatus(msg) {
  var el = $('driveStatus');
  if (el) el.textContent = msg;
}
function driveFmtWhen(ts) {
  var n = Number(ts || 0);
  return n > 0 ? new Date(n).toLocaleString('pt-BR') : 'nunca';
}
function driveRenderSync() {
  var el = $('driveSync');
  if (!el) return;
  el.textContent = 'Envio: ' + driveFmtWhen(localStorage.getItem('ven-driveLastUp')) +
    ' · Baixa: ' + driveFmtWhen(localStorage.getItem('ven-driveLastDown'));
}
function fillDriveForm() {
  var u = $('driveUrl'), k = $('driveKey');
  if (u) u.value = localStorage.getItem('ven-driveUrl') || '';
  if (k) k.value = localStorage.getItem('ven-driveKey') || '';
  driveRenderSync();
}
function driveSaveConfig() {
  localStorage.setItem('ven-driveUrl', String($('driveUrl').value || '').trim());
  localStorage.setItem('ven-driveKey', String($('driveKey').value || '').trim());
  driveShowForce(false);
  driveSetStatus('✔️ Link e chave salvos neste aparelho.');
}
function driveFetchJson(url, options) {
  var p;
  try { p = fetch(url, options); } catch (e) { p = Promise.reject(e); }
  return p.then(function (res) {
    return res.json().catch(function () { return null; });
  }).then(function (body) {
    if (!body || body.ok !== true) {
      if (body && body.error === 'unauthorized') throw new Error('unauthorized');
      throw new Error('network');
    }
    return body;
  }).catch(function (e) {
    if (e && e.message === 'unauthorized') throw e;
    throw new Error('network');
  });
}
function driveErrorAlert(e) {
  alert(e && e.message === 'unauthorized'
    ? '❌ O script recusou a chave. Confira se a chave salva aqui é igual à chave do script.'
    : '❌ Não consegui falar com o script. Confira o link e a conexão com a internet.');
}
function driveShowForce(show) {
  var b = $('driveUpForce');
  if (b) b.classList.toggle('hidden', !show);
}
/* Enviar: antes de escrever, lê a nuvem. Se lá houver MAIS vendas
   que neste aparelho, trava e pede a confirmação explícita do botão
   "Enviar mesmo assim" (trava do ecossistema: backup maior nunca é
   sobrescrito em silêncio por um menor). */
function driveUpload(force) {
  var c = driveConfig();
  if (!c.url || !c.key) { alert('Primeiro cole o link do script e a chave secreta, e toque em Salvar.'); return; }
  driveShowForce(false);
  driveSetStatus('Consultando a nuvem antes de enviar…');
  driveFetchJson(driveApiUrl('read'), { method: 'GET' }).then(function (r) {
    if (!force && r.exists && r.data) {
      if (r.data.app !== 'salro-vendas') {
        driveSetStatus('⚠️ O que está na nuvem não parece um backup do Salro Vendas. ' +
          'Para sobrescrever mesmo assim, toque em "Enviar mesmo assim".');
        driveShowForce(true);
        return;
      }
      var remoteCount = sanitizeState(extractState(r.data)).vendas.length;
      if (shouldBlockUpload(state.vendas.length, remoteCount)) {
        driveSetStatus('⚠️ A nuvem tem ' + remoteCount + ' venda(s) e este aparelho tem ' +
          state.vendas.length + '. Enviar agora substituiria o backup maior pelo menor. ' +
          'Baixe da nuvem e junte primeiro — ou toque em "Enviar mesmo assim" se tiver certeza.');
        driveShowForce(true);
        return;
      }
    }
    driveSetStatus('Enviando pra nuvem…');
    return driveFetchJson(driveApiUrl('write'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(buildBackupPayload(state))
    }).then(function () {
      localStorage.setItem('ven-driveLastUp', String(Date.now()));
      driveSetStatus('✔️ Backup enviado pra nuvem com ' + state.vendas.length +
        (state.vendas.length === 1 ? ' venda.' : ' vendas.'));
      driveRenderSync();
    });
  }).catch(function (e) {
    driveSetStatus('');
    driveErrorAlert(e);
  });
}
/* Baixar e juntar: merge por id que só ACRESCENTA (a versão local de
   um id existente vence), nunca apaga, e a config fica a local. */
function driveDownload() {
  var c = driveConfig();
  if (!c.url || !c.key) { alert('Primeiro cole o link do script e a chave secreta, e toque em Salvar.'); return; }
  driveShowForce(false);
  driveSetStatus('Consultando a nuvem…');
  driveFetchJson(driveApiUrl('read'), { method: 'GET' }).then(function (r) {
    if (!r.exists || !r.data) {
      driveSetStatus('Ainda não há backup na nuvem. Envie o primeiro pelo botão de enviar.');
      return;
    }
    if (!r.data || typeof r.data !== 'object' || r.data.app !== 'salro-vendas') {
      driveSetStatus('❌ O que veio da nuvem não é um backup do Salro Vendas. Nada foi alterado.');
      return;
    }
    var res = mergeCloudDownload(state, r.data);
    state = res.state;
    saveState();
    localStorage.setItem('ven-driveLastDown', String(Date.now()));
    driveRenderSync();
    renderAll();
    driveSetStatus('✔️ Baixado da nuvem: ' + res.added + ' novo(s) juntado(s). Nada foi apagado.');
  }).catch(function (e) {
    driveSetStatus('');
    driveErrorAlert(e);
  });
}

/* Rodapé de versão: "Salro Vendas · versão X.Y" no fim das telas
   Início e Ajustes — é assim que o usuário confirma que a
   atualização chegou. A fonte única é APP_VERSION. O texto é
   preenchido pelo JS e, se o HTML em cache for antigo e não tiver
   o elemento, ele é criado aqui (sem duplicar em re-render). */
function renderVersionFooter(doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || !d.getElementById || !d.createElement) return '';
  var text = 'Salro Vendas · versão ' + APP_VERSION;
  var views = ['view-home', 'view-ajustes'];
  for (var i = 0; i < views.length; i++) {
    var view = d.getElementById(views[i]);
    if (!view || !view.appendChild) continue;
    var found = null;
    if (view.querySelectorAll) {
      var kids = view.querySelectorAll('.app-version');
      if (kids && kids.length) found = kids[0];
    }
    if (!found) {
      found = d.createElement('div');
      found.className = 'app-version';
      view.appendChild(found);
    }
    found.textContent = text;
  }
  return text;
}

function init() {
  state = loadState();
  bindEvents();
  fillConfigForm();
  fillDriveForm();
  renderAll();
  showView('home');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
}

if (typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

/* Exporta as funções puras para testes em Node (ignorado no navegador). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    APP_VERSION: APP_VERSION,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DEFAULT_PRODUCT: DEFAULT_PRODUCT,
    CHANNELS: CHANNELS, CURRENCIES: CURRENCIES,
    toCents: toCents, fmtBRL: fmtBRL, fmtJPY: fmtJPY, fmtUSD: fmtUSD,
    fmtMoney: fmtMoney, fmtDateBR: fmtDateBR,
    feeFor: feeFor, saleBreakdown: saleBreakdown, totals: totals,
    despesasByCurrency: despesasByCurrency, saquesTotals: saquesTotals,
    parseCSV: parseCSV, parseGrossToCents: parseGrossToCents,
    parseDateFlex: parseDateFlex, importSalesFromCSV: importSalesFromCSV,
    CHANNEL_KEYS: CHANNEL_KEYS,
    sanitizeCampanha: sanitizeCampanha, campaignGastoBRL: campaignGastoBRL,
    campaignMetrics: campaignMetrics, adsTotalsBRL: adsTotalsBRL,
    unattributedCount: unattributedCount, productSummaries: productSummaries,
    monthlyLucro: monthlyLucro,
    sanitizeConfig: sanitizeConfig, sanitizeVenda: sanitizeVenda,
    sanitizeDespesa: sanitizeDespesa, sanitizeSaque: sanitizeSaque,
    sanitizeState: sanitizeState, buildBackupPayload: buildBackupPayload,
    buildResumo: buildResumo, mergeCloudDownload: mergeCloudDownload,
    shouldBlockUpload: shouldBlockUpload,
    mergeImport: mergeImport, renderVersionFooter: renderVersionFooter
  };
}
