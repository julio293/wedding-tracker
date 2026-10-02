import Anthropic from '@anthropic-ai/sdk';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, KEYWORDS, INCOME_KEYWORDS, PACKAGE_NOTE } from './categories.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = hasClaude ? new Anthropic() : null;

export const claudeEnabled = hasClaude;

// ---------------------------------------------------------------------------
// Amounts: "15jt", "1,5 juta", "500rb", "750k", "2.5M", "Rp 15.000.000", "15000000"
// ---------------------------------------------------------------------------
const UNIT = { jt: 1e6, juta: 1e6, m: 1e6, mio: 1e6, rb: 1e3, ribu: 1e3, k: 1e3, rbu: 1e3, miliar: 1e9, milyar: 1e9, b: 1e9 };
const AMOUNT_RE = /(?:rp\.?\s*)?(\d[\d.,]*)\s*(miliar|milyar|juta|ribu|jt|rbu|rb|mio|k|m|b)?\b/gi;

export function parseAmount(token, unit) {
  let s = token.trim();
  const mult = unit ? UNIT[unit.toLowerCase()] : 1;
  if (mult > 1) {
    // With a unit, "," or "." is a decimal separator: 1,5jt / 1.5jt
    s = s.replace(',', '.');
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
    return Math.round(parseFloat(s) * mult);
  }
  // No unit: "." and "," are thousands separators in IDR (15.000.000 / 15,000,000)
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return parseInt(s.replace(/[.,]/g, ''), 10);
  return Math.round(parseFloat(s.replace(',', '.')));
}

function findAmounts(text) {
  const out = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const value = parseAmount(m[1], m[2]);
    // Ignore tiny bare numbers (dates, counts like "200 pax") unless they have a unit or Rp prefix
    const explicit = m[2] || /rp/i.test(m[0]);
    if (Number.isFinite(value) && value > 0 && (explicit || value >= 10000)) out.push({ value, index: m.index, raw: m[0] });
  }
  return out;
}

export function guessCategory(text, kind) {
  const t = text.toLowerCase();
  if (kind === 'income') {
    if (/(angpao|angpau|amplop|kado|hadiah|gift)/.test(t)) return 'Angpao & Gifts';
    if (/(ortu|orang ?tua|mama|papa|mami|papi|keluarga|family|parents|kontribusi|contribution)/.test(t)) return 'Family Contribution';
    return 'Other Income';
  }
  for (const [cat, words] of Object.entries(KEYWORDS)) if (words.some((w) => t.includes(w))) return cat;
  return 'Other';
}

function guessMethod(text) {
  const t = text.toLowerCase();
  const banks = ['bca', 'mandiri', 'bni', 'bri', 'cimb', 'jenius', 'permata', 'btn', 'ocbc', 'danamon'];
  const bank = banks.find((b) => new RegExp(`\\b${b}\\b`).test(t));
  if (/(cash|tunai)/.test(t)) return 'Cash';
  if (/(qris)/.test(t)) return 'QRIS';
  if (/(gopay|ovo|dana|shopeepay)/.test(t)) return t.match(/(gopay|ovo|dana|shopeepay)/)[1].toUpperCase();
  if (/(kartu kredit|credit card|cc\b)/.test(t)) return 'Credit card';
  if (bank) return `Transfer ${bank.toUpperCase()}`;
  if (/(transfer|tf\b|trf)/.test(t)) return 'Transfer';
  return null;
}

// Deterministic commands work with or without Claude.
export function parseCommand(text) {
  const t = text.trim().toLowerCase();
  if (/\d/.test(t)) return null; // anything with a number is a record, not a command
  if (/^(rekap|summary|total|saldo|status|laporan|report)\b/.test(t)) return { action: 'summary' };
  if (/^(undo|batal|hapus terakhir|delete last)\b/.test(t)) return { action: 'undo' };
  if (/^(help|bantuan|\?|cara)\b/.test(t)) return { action: 'help' };
  if (/^(dashboard|link)\b/.test(t)) return { action: 'dashboard' };
  return null;
}

// Offline fallback parser — used when no ANTHROPIC_API_KEY is configured.
export function localParse(text) {
  const cmd = parseCommand(text);
  if (cmd) return { ...cmd, entries: [], budgets: [] };

  const t = text.toLowerCase();
  const amounts = findAmounts(text);

  // "budget catering 80jt"
  if (/^(total\s+)?(budget|anggaran)\b/.test(t)) {
    if (!amounts.length) return { action: 'none', entries: [], budgets: [] };
    if (/\b(total|semua|all|overall)\b/.test(t)) return { action: 'set_budget', entries: [], budgets: [], total_budget: amounts[0].value };
    return { action: 'set_budget', entries: [], budgets: [{ category: guessCategory(text, 'expense'), amount: amounts[0].value }] };
  }

  if (!amounts.length) return { action: 'none', entries: [], budgets: [] };
  const kind = INCOME_KEYWORDS.some((w) => t.includes(w)) ? 'income' : 'expense';
  const a = amounts[0];
  const party = kind === 'income' ? (text.match(/\bdari\s+([^\d,.;]+?)(?=\s+\d|\s*$|,|\.)/i)?.[1]?.trim() ?? null) : null;
  const note = text.replace(a.raw, '').replace(/\s+/g, ' ').trim() || null;
  return {
    action: 'add',
    entries: [{ kind, amount: a.value, category: guessCategory(text, kind), party, note, method: guessMethod(text), date: null }],
    budgets: [],
  };
}

// ---------------------------------------------------------------------------
// Claude parser: understands free-form Bahasa/English and reads receipt photos
// ---------------------------------------------------------------------------
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'entries', 'budgets', 'total_budget', 'question'],
  properties: {
    action: { type: 'string', enum: ['add', 'set_budget', 'summary', 'undo', 'help', 'none'] },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'amount', 'category', 'party', 'note', 'method', 'date'],
        properties: {
          kind: { type: 'string', enum: ['expense', 'income'] },
          amount: { type: 'integer', description: 'Whole Rupiah, e.g. 15000000' },
          category: { type: 'string', enum: [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES] },
          party: { type: ['string', 'null'], description: 'Vendor paid, or person/family who gave money' },
          note: { type: ['string', 'null'], description: 'Short description, e.g. "DP 30% catering 500 pax"' },
          method: { type: ['string', 'null'], description: 'Payment method, e.g. "Transfer BCA", "Cash", "QRIS"' },
          date: { type: ['string', 'null'], description: 'YYYY-MM-DD if stated or shown on the receipt, else null' },
        },
      },
    },
    budgets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'amount'],
        properties: {
          category: { type: 'string', enum: EXPENSE_CATEGORIES },
          amount: { type: 'integer' },
        },
      },
    },
    total_budget: { type: ['integer', 'null'], description: 'Overall wedding budget if the user sets one' },
    question: { type: ['string', 'null'], description: 'Ask back (in the user\'s language) only if the amount is genuinely unreadable' },
  },
};

const SYSTEM = `You turn WhatsApp messages from an Indonesian couple into wedding budget records. Messages mix Bahasa Indonesia and English and use IDR shorthand: "jt"/"juta" = million, "rb"/"ribu"/"k" = thousand, "M" usually = million (juta) in this context, "DP" = down payment, "pelunasan" = final payment, "tf"/"trf" = transfer.

Actions:
- add: one or more payments or money received. A single message can contain several lines/items; return one entry per item. Money given to the couple (angpao, amplop, kado, contributions from parents/family) is kind "income"; everything paid out is "expense".
- set_budget: the user is setting a planned budget ("budget catering 80jt", "total budget 300jt").
- summary / undo / help: requests for a recap, to remove the last entry, or for instructions.
- none: chit-chat or anything that isn't a record.

For a photo or PDF (bank transfer screenshot, invoice, nota, kwitansi): read the amount actually paid (not the account balance or admin fee unless that is all there is), the recipient/vendor name, the date and the bank. Combine it with any caption — the caption wins if they disagree about what the payment was for. If the image isn't a payment at all, use action "none".

The couple bought an all-in package — ${PACKAGE_NOTE}. Payments for that package (DP paket, pelunasan paket, termin, or anything mentioning "paket"/"bridal") use category "Paket Bridal". Only use Venue, Catering, Attire & Makeup, Decoration etc. for extras bought outside the package (e.g. upgrades, extra pax, a separate vendor).

Amounts are integers in whole Rupiah. Pick the closest category from the list. Keep notes short. Today is ${new Date().toISOString().slice(0, 10)}.`;

export async function claudeParse({ text, image }) {
  const content = [];
  if (image?.mimetype === 'application/pdf') {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image.data } });
  } else if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mimetype, data: image.data } });
  }
  content.push({ type: 'text', text: text?.trim() ? text : '(photo with no caption)' });

  const request = {
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  };
  let response;
  try {
    // Server-side fallback re-runs a declined request on another model instead of refusing outright.
    response = await client.beta.messages.create({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    console.error('[parser] request with fallbacks rejected, retrying without:', err.message);
    response = await client.messages.create(request);
  }

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to read this message');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude response was cut off');
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text');
  return JSON.parse(textBlock.text);
}

// Main entry: commands short-circuit, then Claude, then the offline parser.
export async function parseMessage({ text = '', image = null }) {
  const cmd = !image && parseCommand(text);
  if (cmd) return { ...cmd, entries: [], budgets: [], via: 'command' };

  if (client) {
    try {
      return { ...(await claudeParse({ text, image })), via: 'claude' };
    } catch (err) {
      console.error('[parser] Claude failed, falling back to local parser:', err.message);
      if (image) return { action: 'none', entries: [], budgets: [], question: 'Fotonya belum bisa kebaca. Ketik nominalnya ya, contoh: "catering DP 15jt"', via: 'error' };
    }
  } else if (image && !text.trim()) {
    return { action: 'none', entries: [], budgets: [], question: 'Foto disimpan, tapi pembacaan struk butuh ANTHROPIC_API_KEY. Kirim ulang dengan caption nominalnya, contoh: "dekor DP 10jt"', via: 'local' };
  }
  return { ...localParse(text), via: 'local' };
}

// "ini untuk catering" / "this is for decor" — names a category but carries no amount.
// Returns the expense category, or null if the text doesn't clearly name one.
export function categoryOnly(text) {
  if (/\d/.test(text) || parseCommand(text)) return null;
  const words = text.trim().split(/\s+/);
  if (words.length > 8) return null; // a sentence, not a label
  const cat = guessCategory(text, 'expense');
  return cat === 'Other' ? null : cat;
}
