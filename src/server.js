import express from 'express';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import * as store from './db.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, PACKAGE_NOTE } from './categories.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// HTTP Basic auth: the browser asks once and remembers it, which works well on phones.
function basicAuth(user, password) {
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const i = decoded.indexOf(':');
      const okUser = safeEqual(decoded.slice(0, i), user);
      const okPass = safeEqual(decoded.slice(i + 1), password);
      if (i > -1 && okUser && okPass) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Wedding Budget", charset="UTF-8"').status(401).send('Login required');
  };
}

export function startServer({ port = Number(process.env.PORT) || 3000, getWaStatus = () => ({ state: 'off' }) } = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.get('/healthz', (_req, res) => res.send('ok')); // for the hosting platform, no auth

  const password = process.env.DASHBOARD_PASSWORD;
  if (password) app.use(basicAuth(process.env.DASHBOARD_USER || 'wedding', password));
  else if (process.env.NODE_ENV === 'production') {
    throw new Error('Set DASHBOARD_PASSWORD before running in production — the dashboard holds your financial data.');
  }

  app.use(express.json());
  app.use(express.static(path.resolve('public')));
  app.use('/receipts', express.static(store.RECEIPTS_DIR));

  app.get('/api/wa-status', (_req, res) => res.json(getWaStatus()));

  app.get('/api/state', (_req, res) => {
    res.json({
      summary: store.summary(),
      entries: store.listEntries(),
      categories: { expense: EXPENSE_CATEGORIES, income: INCOME_CATEGORIES },
      packageNote: PACKAGE_NOTE,
    });
  });

  const validKind = (k) => k === 'expense' || k === 'income';

  app.post('/api/entries', (req, res) => {
    const { kind, amount, category } = req.body || {};
    if (!validKind(kind) || !(Number(amount) > 0) || !category) return res.status(400).json({ error: 'kind, amount and category are required' });
    res.json(store.addEntry({ ...req.body, amount: Number(amount), source: 'dashboard', sender: 'dashboard' }));
  });

  app.patch('/api/entries/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!store.getEntry(id)) return res.status(404).json({ error: 'not found' });
    const fields = { ...req.body };
    if ('amount' in fields && !(Number(fields.amount) > 0)) return res.status(400).json({ error: 'amount must be > 0' });
    if ('kind' in fields && !validKind(fields.kind)) return res.status(400).json({ error: 'bad kind' });
    if ('amount' in fields) fields.amount = Math.round(Number(fields.amount));
    res.json(store.updateEntry(id, fields));
  });

  app.delete('/api/entries/:id', (req, res) => {
    res.json({ ok: store.deleteEntry(Number(req.params.id)) });
  });

  app.put('/api/budgets/:category', (req, res) => {
    const amount = Number(req.body?.amount);
    if (!(amount >= 0)) return res.status(400).json({ error: 'amount must be >= 0' });
    if (amount === 0) store.deleteBudget(req.params.category);
    else store.setBudget(req.params.category, amount);
    res.json({ ok: true });
  });

  app.put('/api/settings', (req, res) => {
    for (const key of ['total_budget', 'wedding_date', 'couple']) {
      if (key in (req.body || {})) store.setSetting(key, req.body[key] === '' ? null : req.body[key]);
    }
    res.json(store.getSettings());
  });

  app.get('/api/export.csv', (_req, res) => {
    const cols = ['id', 'paid_on', 'kind', 'category', 'amount', 'party', 'method', 'note', 'sender', 'source', 'receipt'];
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = store.listEntries().map((e) => cols.map((c) => esc(e[c])).join(','));
    res.type('text/csv').attachment('wedding-budget.csv').send([cols.join(','), ...rows].join('\n'));
  });

  app.listen(port, () => console.log(`[web] dashboard → http://localhost:${port}`));
  return app;
}
