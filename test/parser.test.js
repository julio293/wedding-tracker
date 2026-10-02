import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'wt-'));
delete process.env.ANTHROPIC_API_KEY;
const { localParse, parseAmount } = await import('../src/parser.js');
const { handleMessage } = await import('../src/handler.js');
const store = await import('../src/db.js');

test('IDR shorthand amounts', () => {
  assert.equal(parseAmount('15', 'jt'), 15_000_000);
  assert.equal(parseAmount('1,5', 'jt'), 1_500_000);
  assert.equal(parseAmount('2.5', 'M'), 2_500_000);
  assert.equal(parseAmount('500', 'rb'), 500_000);
  assert.equal(parseAmount('750', 'k'), 750_000);
  assert.equal(parseAmount('15.000.000'), 15_000_000);
  assert.equal(parseAmount('4,500,000'), 4_500_000);
});

test('expense text', () => {
  const r = localParse('catering DP 15jt tf BCA');
  assert.equal(r.action, 'add');
  assert.deepEqual([r.entries[0].kind, r.entries[0].amount, r.entries[0].category, r.entries[0].method],
    ['expense', 15_000_000, 'Catering', 'Transfer BCA']);
  assert.equal(localParse('MUA Rp 4.500.000 cash').entries[0].category, 'Attire & Makeup');
  assert.equal(localParse('catering 500 pax 120jt').entries[0].amount, 120_000_000);
});

test('income text', () => {
  const r = localParse('angpao dari Om Budi 2jt');
  assert.equal(r.entries[0].kind, 'income');
  assert.equal(r.entries[0].category, 'Angpao & Gifts');
  assert.equal(r.entries[0].party, 'Om Budi');
  assert.equal(localParse('kontribusi ortu 50jt').entries[0].category, 'Family Contribution');
});

test('budget + commands', () => {
  assert.deepEqual(localParse('budget catering 80jt').budgets, [{ category: 'Catering', amount: 80_000_000 }]);
  assert.equal(localParse('total budget 350jt').total_budget, 350_000_000);
  assert.equal(localParse('budget dekor 1,5jt').budgets[0].amount, 1_500_000);
  assert.equal(localParse('budget total 350jt').total_budget, 350_000_000);
  assert.equal(localParse('rekap').action, 'summary');
  assert.equal(localParse('undo').action, 'undo');
  assert.equal(localParse('halo semua').action, 'none');
});

test('handler end-to-end', async () => {
  await handleMessage({ text: 'budget catering 80jt', sender: 'a' });
  const reply = await handleMessage({ text: 'catering DP 15jt tf BCA', sender: 'a' });
  assert.match(reply, /Rp 15\.000\.000/);
  assert.match(reply, /Catering: 15 jt \/ 80 jt \(19%\)/);
  await handleMessage({ text: 'angpao dari Tante Rina 1jt', sender: 'b' });
  const s = store.summary();
  assert.equal(s.spent, 15_000_000);
  assert.equal(s.income, 1_000_000);
  assert.equal(s.remaining, 65_000_000);
  assert.match(await handleMessage({ text: 'undo', sender: 'a' }), /Dihapus/);
  assert.equal(store.summary().spent, 0);
  assert.equal(await handleMessage({ text: 'halo', sender: 'a' }), null);
});

test('photo then "ini untuk catering" re-files the photo entry', async () => {
  const e = store.addEntry({ kind: 'expense', amount: 7_500_000, category: 'Other', receipt: 'x.jpg', sender: 'c' });
  const reply = await handleMessage({ text: 'ini untuk catering', sender: 'c' });
  assert.match(reply, /Dipindah ke \*Catering\*/);
  assert.equal(store.getEntry(e.id).category, 'Catering');
  // no recent photo entry from this sender -> treated as a normal message
  assert.equal(await handleMessage({ text: 'ini untuk dekor', sender: 'nobody' }), null);
});

test('package payments go to Paket Bridal', () => {
  assert.equal(localParse('DP paket bridal 10jt').entries[0].category, 'Paket Bridal');
  assert.equal(localParse('pelunasan paket catering 24,5jt').entries[0].category, 'Paket Bridal');
  assert.equal(localParse('catering tambahan 50 pax 5jt').entries[0].category, 'Catering');
  assert.deepEqual(localParse('budget paket bridal 34,5jt').budgets, [{ category: 'Paket Bridal', amount: 34_500_000 }]);
});

test('leading "help" line is ignored and unbudgeted spend is not "over budget"', async () => {
  const before = store.summary();
  const reply = await handleMessage({ text: 'help\nwedding rings 25jt', sender: 'd' });
  assert.match(reply, /Rings & Jewelry/);
  assert.equal(store.listEntries()[0].note, 'wedding rings');
  const s = store.summary();
  assert.equal(s.budgetScope, 'categories');
  assert.equal(s.remaining - before.remaining, 0); // rings have no budget, so remaining is unchanged
});
