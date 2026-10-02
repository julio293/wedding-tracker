# 💍 Wedding Tracker

Log wedding spending and angpao from WhatsApp; see it all on a local dashboard.

## Setup

```bash
cd ~/wedding-tracker
cp .env.example .env      # add ANTHROPIC_API_KEY for receipt photos + smarter parsing
npm start
```

1. Create a WhatsApp group named **Wedding Budget** (add your partner if you like).
2. Scan the QR printed in the terminal: WhatsApp → Settings → Linked devices → Link a device.
3. Open http://localhost:3000.

The session is saved in `data/wa-session`, so you only scan once. Keep the Mac awake while you want messages recorded.

## What to send

| Message | Result |
|---|---|
| `catering DP 15jt tf BCA` | Expense, Catering, Rp 15.000.000 |
| `MUA 4.500.000 cash` | Expense, Attire & Makeup |
| 📷 transfer screenshot / invoice / PDF | Claude reads amount, vendor, date, bank |
| `angpao dari Om Budi 2jt` | Income, Angpao & Gifts |
| `kontribusi ortu 50jt` | Income, Family Contribution |
| `budget catering 80jt` / `total budget 350jt` | Sets budgets |
| `rekap` · `undo` · `help` · `dashboard` | Commands |

Several items in one message (one per line) work when Claude is enabled.

## Other

- `npm run dashboard`: dashboard only, without WhatsApp
- `npm test`: parser + handler tests
- Data: `data/wedding.db` (SQLite) and `data/receipts/`. Back up the `data/` folder.
- Export CSV from the dashboard header.

Uses whatsapp-web.js (unofficial WhatsApp Web automation). Fine for personal use, but WhatsApp can in principle restrict accounts that automate — this bot only replies inside the one group.

## Running on this Mac (current setup)

The bot + dashboard run as background services, with a Cloudflare quick tunnel for a public link.

```bash
./scripts/mac-service.sh install    # start now + on every login, auto-restart on crash
./scripts/mac-service.sh status     # running? + current public link
./scripts/mac-service.sh logs       # follow logs
./scripts/mac-service.sh restart    # restart the bot
./scripts/mac-service.sh uninstall  # stop and remove
```

- Login: user `wedding` + `DASHBOARD_PASSWORD` from `.env`.
- The free tunnel gets a **new link whenever it restarts**; the bot posts the new link in the group, and `dashboard` in the group always replies with the current one.
- Keep the Mac plugged in. `caffeinate` stops idle sleep, but closing the lid on battery still sleeps it.
- Logs: `logs/app.log`, `logs/tunnel.log`.

## Online (Railway) — previous setup, stopped

Live at https://app-production-749e.up.railway.app (HTTP Basic login, user `wedding`).

- Project `wedding-tracker`, service `app`, volume mounted at `/data` (DB, receipts, WhatsApp session).
- Redeploy after code changes: `railway up --ci`
- Logs: `railway logs` · Variables: `railway variables`
- Change password: `railway variables --set DASHBOARD_PASSWORD=...`
- Add Claude: `railway variables --set ANTHROPIC_API_KEY=sk-ant-...`
- Don't run `npm start` locally with the same WhatsApp linked at the same time — both would record and reply.
