'use strict';

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = 'vitrine_zap_tabela_precos_sku_v1';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));

const required = [
  'FIREBASE_DATABASE_URL',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'SESSION_SECRET'
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error('Variáveis obrigatórias ausentes:', missing.join(', '));
  process.exit(1);
}

if (process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET precisa ter pelo menos 32 caracteres.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON não contém JSON válido.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const productsRef = db.ref(DB_PATH);

app.use(session({
  name: 'vitrinezap.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

function normalizeSku(value) {
  const sku = String(value ?? '').trim().toUpperCase();
  if (!sku || sku.length > 80 || /[.#$[\]/\u0000-\u001f]/.test(sku)) {
    return null;
  }
  return sku;
}

function cleanText(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin === true) return next();
  return res.status(401).json({ erro: 'Faça login no painel administrativo.' });
}

function requireAgentKey(req, res, next) {
  const expected = process.env.AGENT_API_KEY;
  if (!expected) {
    return res.status(503).json({ erro: 'API do agente ainda não configurada.' });
  }

  const supplied = req.get('x-api-key') || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ erro: 'Chave de API inválida.' });
  }
  next();
}

function buildProduct(body, sku) {
  const nome = cleanText(body.nome, 160);
  const descricao = cleanText(body.descricao, 1000);
  const preco = Number(body.preco);

  if (!nome) throw new Error('Informe o nome do produto.');
  if (body.preco === '' || body.preco === null ||
      body.preco === undefined || !Number.isFinite(preco) || preco < 0) {
    throw new Error('Informe um preço válido, igual ou maior que zero.');
  }

  return {
    sku,
    nome,
    preco: Math.round(preco * 100) / 100,
    descricao,
    disponivel: body.disponivel !== false,
    atualizadoEm: new Date().toISOString()
  };
}

async function getProduct(sku) {
  const snapshot = await productsRef.child(sku).get();
  return snapshot.exists() ? snapshot.val() : null;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'online', servico: 'Vitrine Zap Preços' });
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Consulta pública por SKU.
app.get('/api/v1/precos/:sku', async (req, res) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(400).json({ erro: 'SKU inválido.' });

    const produto = await getProduct(sku);
    if (!produto || produto.disponivel === false) {
      return res.status(404).json({ erro: 'Produto não encontrado ou indisponível.' });
    }

    res.set('Cache-Control', 'no-store');
    res.json({ sucesso: true, produto });
  } catch (error) {
    console.error('Falha na consulta pública:', error.message);
    res.status(500).json({ erro: 'Não foi possível consultar o preço.' });
  }
});

// Lista pública de produtos disponíveis.
app.get('/api/v1/precos', async (req, res) => {
  try {
    const snapshot = await productsRef.get();
    const all = snapshot.val() || {};
    const termo = cleanText(req.query.q, 100).toLowerCase();

    const produtos = Object.values(all)
      .filter((p) => p && p.disponivel !== false)
      .filter((p) =>
        !termo ||
        String(p.sku || '').toLowerCase().includes(termo) ||
        String(p.nome || '').toLowerCase().includes(termo)
      )
      .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'))
      .slice(0, 500);

    res.set('Cache-Control', 'no-store');
    res.json({ sucesso: true, total: produtos.length, produtos });
  } catch (error) {
    console.error('Falha na listagem pública:', error.message);
    res.status(500).json({ erro: 'Não foi possível carregar os preços.' });
  }
});

// Endpoint para o futuro agente de IA. Exige chave no cabeçalho x-api-key.
app.get('/api/v1/agente/precos/:sku', requireAgentKey, async (req, res) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(400).json({ erro: 'SKU inválido.' });

    const produto = await getProduct(sku);
    if (!produto || produto.disponivel === false) {
      return res.status(404).json({ erro: 'Produto não encontrado ou indisponível.' });
    }

    res.json({
      sku: produto.sku,
      nome: produto.nome,
      preco: produto.preco,
      moeda: 'BRL',
      descricao: produto.descricao || '',
      disponivel: true
    });
  } catch (error) {
    console.error('Falha na API do agente:', error.message);
    res.status(500).json({ erro: 'Erro ao consultar o produto.' });
  }
});

app.post('/api/admin/login', (req, res, next) => {
  const username = String(req.body?.username ?? '');
  const password = String(req.body?.password ?? '');

  if (username !== process.env.ADMIN_USERNAME ||
      password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  }

  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.isAdmin = true;
    req.session.username = username;

    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.json({ sucesso: true, usuario: username });
    });
  });
});

app.get('/api/admin/me', (req, res) => {
  if (!req.session?.isAdmin) {
    return res.status(401).json({ autenticado: false });
  }
  res.json({ autenticado: true, usuario: req.session.username });
});

app.post('/api/admin/logout', requireAdmin, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('vitrinezap.sid', {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production'
    });
    res.json({ sucesso: true });
  });
});

app.get('/api/admin/produtos', requireAdmin, async (_req, res) => {
  try {
    const snapshot = await productsRef.get();
    const all = snapshot.val() || {};
    const produtos = Object.values(all)
      .filter(Boolean)
      .sort((a, b) => String(a.sku).localeCompare(String(b.sku)));

    res.json({ sucesso: true, produtos });
  } catch (error) {
    console.error('Falha ao listar produtos:', error.message);
    res.status(500).json({ erro: 'Não foi possível carregar os produtos.' });
  }
});

app.post('/api/admin/produtos', requireAdmin, async (req, res) => {
  try {
    const sku = normalizeSku(req.body?.sku);
    if (!sku) return res.status(400).json({ erro: 'SKU inválido.' });

    const ref = productsRef.child(sku);
    const existing = await ref.get();
    if (existing.exists()) {
      return res.status(409).json({ erro: 'Este SKU já existe. Use editar.' });
    }

    const produto = buildProduct(req.body, sku);
    produto.criadoEm = new Date().toISOString();
    await ref.set(produto);

    res.status(201).json({ sucesso: true, produto });
  } catch (error) {
    if (error.message.startsWith('Informe')) {
      return res.status(400).json({ erro: error.message });
    }
    console.error('Falha ao cadastrar produto:', error.message);
    res.status(500).json({ erro: 'Não foi possível cadastrar o produto.' });
  }
});

app.put('/api/admin/produtos/:sku', requireAdmin, async (req, res) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(400).json({ erro: 'SKU inválido.' });

    const ref = productsRef.child(sku);
    const existing = await ref.get();
    if (!existing.exists()) {
      return res.status(404).json({ erro: 'SKU não encontrado.' });
    }

    const produto = buildProduct(req.body, sku);
    produto.criadoEm = existing.val().criadoEm || new Date().toISOString();
    await ref.set(produto);

    res.json({ sucesso: true, produto });
  } catch (error) {
    if (error.message.startsWith('Informe')) {
      return res.status(400).json({ erro: error.message });
    }
    console.error('Falha ao editar produto:', error.message);
    res.status(500).json({ erro: 'Não foi possível editar o produto.' });
  }
});

app.delete('/api/admin/produtos/:sku', requireAdmin, async (req, res) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(400).json({ erro: 'SKU inválido.' });

    const ref = productsRef.child(sku);
    const existing = await ref.get();
    if (!existing.exists()) {
      return res.status(404).json({ erro: 'SKU não encontrado.' });
    }

    await ref.remove();
    res.json({ sucesso: true, sku });
  } catch (error) {
    console.error('Falha ao excluir produto:', error.message);
    res.status(500).json({ erro: 'Não foi possível excluir o produto.' });
  }
});

app.use((error, _req, res, _next) => {
  console.error('Erro interno:', error.message);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Vitrine Zap Preços ouvindo na porta ${PORT}`);
  console.log(`Firebase: caminho isolado ${DB_PATH}`);
});
