import { startServer } from './server.js';
import { claudeEnabled } from './parser.js';

const withWhatsApp = !process.argv.includes('--no-whatsapp') && process.env.WHATSAPP !== 'off';
let getWaStatus = () => ({ state: 'off' });
let stopBot = async () => {};

if (withWhatsApp) {
  const bot = await import('./bot.js');
  const { startBot, waStatus } = bot;
  stopBot = bot.stopBot;
  getWaStatus = () => waStatus;
  startServer({ getWaStatus });
  startBot();
} else {
  startServer({ getWaStatus });
}

// On the Mac, a Cloudflare quick tunnel gives the dashboard a public link (see launchd/README).
if (process.env.TUNNEL !== 'off' && !process.env.RAILWAY_ENVIRONMENT) {
  const { watchTunnel } = await import('./tunnel.js');
  watchTunnel({
    onChange: async (url) => {
      if (!withWhatsApp) return;
      const { announce } = await import('./bot.js');
      announce(`📊 Link dashboard baru: ${url}\n_(login: ${process.env.DASHBOARD_USER || 'wedding'} + password yang sama)_`);
    },
  });
}

console.log(claudeEnabled
  ? '[ai] Claude enabled — free-form messages and receipt photos will be read automatically'
  : '[ai] No ANTHROPIC_API_KEY — using the offline text parser (receipt photos need a caption)');

// whatsapp-web.js/puppeteer occasionally reject promises nobody is awaiting; log instead of crashing.
process.on('unhandledRejection', (err) => console.error('[process] unhandled rejection:', err?.message || err));
process.on('uncaughtException', (err) => console.error('[process] uncaught exception:', err?.stack || err));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('[process] shutting down — closing WhatsApp cleanly');
  await stopBot();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
