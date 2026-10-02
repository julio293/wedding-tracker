import { getSettings, setSetting } from './db.js';

// Cloudflare quick tunnels get a fresh *.trycloudflare.com hostname on every start.
// cloudflared exposes it on its metrics port; keep PUBLIC_URL in sync and announce changes.
const METRICS = process.env.TUNNEL_METRICS || 'http://127.0.0.1:20241';

export function watchTunnel({ onChange = () => {} } = {}) {
  let current = null;
  async function poll() {
    try {
      const res = await fetch(`${METRICS}/quicktunnel`, { signal: AbortSignal.timeout(3000) });
      const { hostname } = await res.json();
      if (!hostname) return;
      const url = `https://${hostname}`;
      if (url === current) return;
      current = url;
      process.env.PUBLIC_URL = url;
      console.log(`[tunnel] public dashboard → ${url}`);
      if (getSettings().public_url !== url) {
        setSetting('public_url', url);
        onChange(url);
      }
    } catch {
      // cloudflared not running (yet) — dashboard stays reachable on localhost
    }
  }
  poll();
  setInterval(poll, 30000).unref();
}
