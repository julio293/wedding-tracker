import * as store from './db.js';
import { parseMessage, claudeEnabled, categoryOnly } from './parser.js';

// SQLite datetime('now') is UTC without a zone marker
const minutesAgo = (sqliteUtc) => (Date.now() - new Date(sqliteUtc.replace(' ', 'T') + 'Z').getTime()) / 60000;

export const rupiah = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

// Compact form for chat replies: 15.000.000 -> "15 jt", 750.000 -> "750 rb"
export function short(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${+(a / 1e9).toFixed(2)} M`;
  if (a >= 1e6) return `${sign}${+(a / 1e6).toFixed(1)} jt`;
  if (a >= 1e3) return `${sign}${+(a / 1e3).toFixed(0)} rb`;
  return `${sign}${a}`;
}

const DASHBOARD_URL = () => process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

export const HELP = `💍 *Wedding Tracker*

*Catat pengeluaran* (bebas formatnya):
• catering DP 15jt tf BCA
• dekor pelunasan 22,5jt ke Rumah Bunga
• MUA 4.500.000 cash
• Beberapa sekaligus, satu per baris

*Catat pemasukan / angpao:*
• angpao dari Om Budi 2jt
• kontribusi ortu 50jt

*Foto struk / bukti transfer* — kirim fotonya, caption opsional:
• caption "ini untuk catering" → nominal dibaca dari foto
• atau kirim foto dulu, lalu ketik "ini untuk catering"

*Budget:*
• budget catering 80jt
• total budget 350jt

*Perintah:* rekap · undo · help · dashboard`;

function categoryLine(cat) {
  const s = store.summary();
  const spent = s.spentByCat.find((c) => c.category === cat)?.spent ?? 0;
  const budget = s.budgets.find((b) => b.category === cat)?.amount;
  if (!budget) return `${cat}: ${short(spent)} terpakai`;
  const pct = Math.round((spent / budget) * 100);
  const flag = spent > budget ? ' ⚠️ over budget' : '';
  return `${cat}: ${short(spent)} / ${short(budget)} (${pct}%)${flag}`;
}

export function summaryText() {
  const s = store.summary();
  const lines = [`💍 *Rekap Wedding*`, ''];
  lines.push(`💸 Pengeluaran: *${rupiah(s.spent)}* (${s.expenseCount}x)`);
  lines.push(`🎁 Pemasukan: *${rupiah(s.income)}* (${s.incomeCount}x)`);
  if (s.budget) {
    lines.push(`📋 Budget: ${rupiah(s.budget)}`);
    lines.push(`${s.remaining < 0 ? '🔴' : '🟢'} Sisa budget: *${rupiah(s.remaining)}* (${Math.round((s.spentAgainstBudget / s.budget) * 100)}% terpakai)`);
    if (s.budgetScope === 'categories') lines.push('_(hanya kategori yang punya budget — set "total budget 350jt" untuk keseluruhan)_');
  }
  const cats = [...s.spentByCat].sort((a, b) => b.spent - a.spent);
  if (cats.length) {
    lines.push('', '*Per kategori:*');
    for (const c of cats) lines.push(`• ${categoryLine(c.category)}`);
  }
  lines.push('', `📊 ${DASHBOARD_URL()}`);
  return lines.join('\n');
}

/**
 * Handle one incoming WhatsApp message. Returns the reply text, or null to stay silent.
 * @param {{ text: string, image?: {mimetype: string, data: string}, receiptPath?: string, sender?: string, msgId?: string }} msg
 */
const FOLLOW_UP_MINUTES = 10;

export async function handleMessage({ text = '', image = null, receiptPath = null, sender = null, msgId = null }) {
  // People often start with "help" before the actual entry ("help\nwedding rings 25jt") — drop it.
  if (/^\s*(help|bantuan|tolong)\b[\s:,-]*/i.test(text) && /\d/.test(text)) text = text.replace(/^\s*(help|bantuan|tolong)\b[\s:,-]*/i, '');
  // Photo first, then "ini untuk catering" as its own message: re-file the photo's entry.
  if (!image) {
    const cat = categoryOnly(text);
    const last = cat && store.lastEntryFrom(sender);
    if (last?.receipt && last.kind === 'expense' && minutesAgo(last.created_at) <= FOLLOW_UP_MINUTES) {
      const before = last.category;
      store.updateEntry(last.id, { category: cat, note: last.note || text.trim() });
      return `✏️ Dipindah ke *${cat}*${before !== cat ? ` (sebelumnya ${before})` : ''}: ${rupiah(last.amount)}${last.party ? ` · ${last.party}` : ''}\n\n${categoryLine(cat)}`;
    }
  }

  const parsed = await parseMessage({ text, image });

  switch (parsed.action) {
    case 'help':
      return HELP + (claudeEnabled ? '' : '\n\n_(Mode offline: pembacaan foto struk butuh ANTHROPIC_API_KEY)_');
    case 'dashboard':
      return `📊 Dashboard: ${DASHBOARD_URL()}`;
    case 'summary':
      return summaryText();
    case 'undo': {
      const last = store.deleteLastFrom(sender);
      return last
        ? `↩️ Dihapus: ${last.kind === 'income' ? '🎁' : '💸'} ${rupiah(last.amount)} — ${last.category}${last.note ? ` (${last.note})` : ''}`
        : 'Belum ada catatan untuk dihapus.';
    }
    case 'set_budget': {
      const out = ['📋 Budget disimpan:'];
      for (const b of parsed.budgets || []) {
        store.setBudget(b.category, b.amount);
        out.push(`• ${b.category}: ${rupiah(b.amount)}`);
      }
      if (parsed.total_budget) {
        store.setSetting('total_budget', parsed.total_budget);
        out.push(`• Total: ${rupiah(parsed.total_budget)}`);
      }
      return out.length > 1 ? out.join('\n') : 'Nominal budget-nya belum kebaca. Contoh: "budget catering 80jt"';
    }
    case 'add': {
      const entries = (parsed.entries || []).filter((e) => e.amount > 0);
      if (!entries.length) return parsed.question || 'Nominalnya belum kebaca. Contoh: "catering DP 15jt"';
      const saved = entries.map((e) =>
        store.addEntry({
          kind: e.kind, amount: e.amount, category: e.category, party: e.party, note: e.note, method: e.method,
          paid_on: e.date, receipt: receiptPath, sender, raw: text || null, wa_msg_id: msgId,
        }),
      );
      const lines = saved.map((e) => {
        const icon = e.kind === 'income' ? '🎁' : '💸';
        const who = e.party ? ` · ${e.party}` : '';
        const how = e.method ? ` · ${e.method}` : '';
        return `${icon} *${rupiah(e.amount)}* — ${e.category}${who}${how}${e.note ? `\n   _${e.note}_` : ''}`;
      });
      const touched = [...new Set(saved.filter((e) => e.kind === 'expense').map((e) => e.category))];
      const s = store.summary();
      const footer = [];
      for (const c of touched) footer.push(categoryLine(c));
      footer.push(`Total keluar ${short(s.spent)}${s.budget ? ` · sisa ${short(s.remaining)}` : ''} · masuk ${short(s.income)}`);
      return `✅ Tercatat${saved.length > 1 ? ` (${saved.length})` : ''}:\n${lines.join('\n')}\n\n${footer.join('\n')}\n_Salah? ketik "undo"_`;
    }
    default:
      // Only answer non-records when we actually need something from the user (e.g. unreadable photo).
      return parsed.question || null;
  }
}
