import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
mkdirSync(path.join(DATA_DIR, 'receipts'), { recursive: true });

export const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
export const db = new DatabaseSync(path.join(DATA_DIR, 'wedding.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    amount     INTEGER NOT NULL CHECK (amount > 0),
    category   TEXT NOT NULL,
    party      TEXT,
    note       TEXT,
    method     TEXT,
    paid_on    TEXT NOT NULL,
    receipt    TEXT,
    source     TEXT NOT NULL DEFAULT 'whatsapp',
    sender     TEXT,
    raw        TEXT,
    wa_msg_id  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS budgets (
    category TEXT PRIMARY KEY,
    amount   INTEGER NOT NULL CHECK (amount >= 0)
  );
  CREATE TABLE IF NOT EXISTS wa_seen (
    id      TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

export function addEntry(e) {
  const stmt = db.prepare(`
    INSERT INTO entries (kind, amount, category, party, note, method, paid_on, receipt, source, sender, raw, wa_msg_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const r = stmt.run(
    e.kind, Math.round(e.amount), e.category, e.party ?? null, e.note ?? null, e.method ?? null,
    e.paid_on || today(), e.receipt ?? null, e.source ?? 'whatsapp', e.sender ?? null, e.raw ?? null, e.wa_msg_id ?? null,
  );
  return getEntry(Number(r.lastInsertRowid));
}

export const getEntry = (id) => db.prepare('SELECT * FROM entries WHERE id = ?').get(id);

export function updateEntry(id, fields) {
  const allowed = ['kind', 'amount', 'category', 'party', 'note', 'method', 'paid_on'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getEntry(id);
  db.prepare(`UPDATE entries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return getEntry(id);
}

export const deleteEntry = (id) => db.prepare('DELETE FROM entries WHERE id = ?').run(id).changes > 0;

export function deleteLastFrom(sender) {
  const last = sender
    ? db.prepare("SELECT * FROM entries WHERE sender = ? AND source = 'whatsapp' ORDER BY id DESC LIMIT 1").get(sender)
    : db.prepare('SELECT * FROM entries ORDER BY id DESC LIMIT 1').get();
  if (last) deleteEntry(last.id);
  return last;
}

export function lastEntryFrom(sender) {
  return db.prepare("SELECT * FROM entries WHERE sender IS ? AND source = 'whatsapp' ORDER BY id DESC LIMIT 1").get(sender ?? null);
}

export const listEntries = () => db.prepare('SELECT * FROM entries ORDER BY paid_on DESC, id DESC').all();

export const listBudgets = () => db.prepare('SELECT * FROM budgets ORDER BY category').all();

export function setBudget(category, amount) {
  db.prepare(`INSERT INTO budgets (category, amount) VALUES (?, ?)
              ON CONFLICT(category) DO UPDATE SET amount = excluded.amount`).run(category, Math.round(amount));
}

export const deleteBudget = (category) => db.prepare('DELETE FROM budgets WHERE category = ?').run(category);

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value == null ? null : String(value));
}

export function summary() {
  const totals = db.prepare(`SELECT kind, SUM(amount) AS total, COUNT(*) AS n FROM entries GROUP BY kind`).all();
  const byKind = Object.fromEntries(totals.map((t) => [t.kind, { total: t.total, n: t.n }]));
  const spentByCat = db.prepare(`SELECT category, SUM(amount) AS spent, COUNT(*) AS n
                                 FROM entries WHERE kind = 'expense' GROUP BY category`).all();
  const incomeByCat = db.prepare(`SELECT category, SUM(amount) AS total, COUNT(*) AS n
                                  FROM entries WHERE kind = 'income' GROUP BY category`).all();
  const budgets = listBudgets();
  const budgetTotal = budgets.reduce((s, b) => s + b.amount, 0);
  const settings = getSettings();
  const hasTotal = Boolean(settings.total_budget);
  const overall = hasTotal ? Number(settings.total_budget) : budgetTotal;
  const spent = byKind.expense?.total ?? 0;
  const income = byKind.income?.total ?? 0;
  // Without an overall budget, only compare spending in categories that actually have a budget —
  // otherwise unbudgeted spending (rings, souvenirs…) shows up as "over budget".
  const budgeted = new Set(budgets.map((b) => b.category));
  const spentAgainstBudget = hasTotal ? spent : spentByCat.filter((c) => budgeted.has(c.category)).reduce((s, c) => s + c.spent, 0);
  return {
    spent, income,
    expenseCount: byKind.expense?.n ?? 0,
    incomeCount: byKind.income?.n ?? 0,
    budget: overall,
    budgetFromCategories: budgetTotal,
    remaining: overall - spentAgainstBudget,
    spentAgainstBudget,
    budgetScope: hasTotal ? 'total' : 'categories',
    net: income - spent,
    spentByCat, incomeByCat, budgets, settings,
  };
}

// WhatsApp message ids we've already handled — lets the bot safely catch up on backlog after restarts.
// Returns true the first time an id is claimed, false if it was already processed.
export function claimMessage(id) {
  return db.prepare('INSERT OR IGNORE INTO wa_seen (id) VALUES (?)').run(id).changes > 0;
}
