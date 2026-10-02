#!/bin/zsh
# Run the wedding tracker on this Mac as background services (launchd).
#   ./scripts/mac-service.sh install    start now + on every login, auto-restart on crash
#   ./scripts/mac-service.sh uninstall  stop and remove
#   ./scripts/mac-service.sh status     show what's running + the public link
#   ./scripts/mac-service.sh logs       follow the app log
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
APP=com.wedding-tracker.app
TUN=com.wedding-tracker.tunnel
NODE="$(command -v node)"
CLOUDFLARED="$(command -v cloudflared)"
UID_NUM="$(id -u)"

write_plists() {
  mkdir -p "$AGENTS" "$DIR/logs"
  # caffeinate -is keeps the Mac from idle-sleeping while the bot runs (display may still turn off)
  cat > "$AGENTS/$APP.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$APP</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$NODE</string><string>--env-file-if-exists=.env</string><string>src/index.js</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$DIR/logs/app.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/app.log</string>
</dict></plist>
PLIST
  cat > "$AGENTS/$TUN.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$TUN</string>
  <key>ProgramArguments</key><array>
    <string>$CLOUDFLARED</string><string>tunnel</string><string>--no-autoupdate</string>
    <string>--url</string><string>http://localhost:3000</string>
    <string>--metrics</string><string>127.0.0.1:20241</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$DIR/logs/tunnel.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/tunnel.log</string>
</dict></plist>
PLIST
}

case "${1:-status}" in
  install)
    [ -n "$NODE" ] || { echo "node not found"; exit 1; }
    [ -n "$CLOUDFLARED" ] || { echo "cloudflared not found (brew install cloudflared)"; exit 1; }
    write_plists
    for L in $TUN $APP; do
      launchctl bootout "gui/$UID_NUM/$L" 2>/dev/null || true
      launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$L.plist"
    done
    echo "Installed. Dashboard: http://localhost:3000 — public link appears in ~20s (run: $0 status)"
    ;;
  uninstall)
    for L in $APP $TUN; do
      launchctl bootout "gui/$UID_NUM/$L" 2>/dev/null || true
      rm -f "$AGENTS/$L.plist"
    done
    echo "Stopped and removed."
    ;;
  restart)
    launchctl kickstart -k "gui/$UID_NUM/$APP"
    echo "App restarted."
    ;;
  status)
    for L in $APP $TUN; do
      if launchctl print "gui/$UID_NUM/$L" >/dev/null 2>&1; then
        PID=$(launchctl print "gui/$UID_NUM/$L" | awk '/^\tpid =/ {print $3}')
        echo "$L: running${PID:+ (pid $PID)}"
      else
        echo "$L: not installed"
      fi
    done
    URL=$(curl -s --max-time 2 127.0.0.1:20241/quicktunnel | sed -n 's/.*"hostname":"\([^"]*\)".*/https:\/\/\1/p')
    echo "Public link: ${URL:-not ready yet}"
    ;;
  logs)
    tail -f "$DIR/logs/app.log"
    ;;
  *) echo "usage: $0 install|uninstall|restart|status|logs"; exit 1 ;;
esac
