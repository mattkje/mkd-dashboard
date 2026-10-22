#!/usr/bin/env bash
# One-step install (or update) of the MKD dashboard on a Debian/Ubuntu server:
#
#   curl -fsSL https://raw.githubusercontent.com/mattkje/mkd-dashboard/HEAD/setup.sh | bash
#
# Run it as the user the dashboard should run as (not root); it uses sudo where needed.
# It asks a few questions, installs what is missing (git, Node.js, Python, tmux,
# Tailscale), clones the repo, writes /etc/mkd-dashboard.env, installs the service
# and publishes it on your tailnet. Run it again later to update.
set -euo pipefail

REPO_URL="${MKD_REPO:-https://github.com/mattkje/mkd-dashboard.git}"
ENV_FILE=/etc/mkd-dashboard.env
NODE_MAJOR=22

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

# Questions read from the terminal, also when this script itself arrives through a pipe.
# Without a terminal every question takes its default.
if [ -r /dev/tty ] && [ -w /dev/tty ]; then TTY=/dev/tty; else TTY=; fi

ask() { # ask VAR "Question" "default"
  local _reply='' # not named like any caller's variable, or printf -v would set this local
  if [ -n "$TTY" ]; then
    printf '%s%s: ' "$2" "${3:+ [$3]}" > "$TTY"
    IFS= read -r _reply < "$TTY" || true
  fi
  printf -v "$1" '%s' "${_reply:-$3}"
}

ask_secret() { # ask_secret VAR "Question"  (empty answer keeps VAR as it is)
  local _reply=''
  if [ -n "$TTY" ]; then
    printf '%s: ' "$2" > "$TTY"
    IFS= read -rs _reply < "$TTY" || true
    printf '\n' > "$TTY"
  fi
  if [ -n "$_reply" ]; then printf -v "$1" '%s' "$_reply"; fi
}

confirm() { # confirm "Question" y|n
  local answer
  ask answer "$1 (y/n)" "$2"
  [[ "$answer" =~ ^[Yy] ]]
}

# Reads one setting from the existing env file (it is root-only, hence sudo).
current() {
  { sudo cat "$ENV_FILE" 2>/dev/null || true; } | sed -n "s/^$1=//p" | tail -n 1
}

node_ok() {
  has node && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) || (a === 20 && b >= 19) ? 0 : 1)'
}

# --- Checks --------------------------------------------------------------------

[ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not root. It uses sudo where it needs to."
has apt-get || fail "this installer supports Debian and Ubuntu (apt) only."
has systemctl || fail "systemd is required."
has sudo || fail "sudo is required."

bold "MKD dashboard setup"
info "It runs as $(whoami), with sudo for the system parts."
sudo -v || fail "sudo is needed."

# --- Questions -----------------------------------------------------------------

DEFAULT_DIR="$HOME/mkd-dashboard"
ask APP_DIR "Install folder" "$DEFAULT_DIR"
APP_DIR="${APP_DIR/#\~/$HOME}"
[ -d "$APP_DIR/.git" ] && UPDATE=1 || UPDATE=

RECONFIGURE=1
if sudo test -f "$ENV_FILE"; then
  if confirm "Settings exist in $ENV_FILE. Keep them?" y; then RECONFIGURE=; fi
fi

if [ -n "$RECONFIGURE" ]; then
  ADMIN_PASSWORD="$(current ADMIN_PASSWORD)"
  if [ -n "$ADMIN_PASSWORD" ]; then
    ask_secret ADMIN_PASSWORD "Admin password (Enter keeps the current one)"
  else
    GENERATED_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
    ADMIN_PASSWORD="$GENERATED_PASSWORD"
    ask_secret ADMIN_PASSWORD "Admin password (Enter generates a random one)"
  fi

  bold "Alerts (optional; Enter skips)"
  ask NTFY_URL "  ntfy topic URL, e.g. https://ntfy.sh/a-long-random-topic" "$(current NTFY_URL)"
  ask TELEGRAM_BOT_TOKEN "  Telegram bot token" "$(current TELEGRAM_BOT_TOKEN)"
  TELEGRAM_CHAT_ID=''
  [ -z "$TELEGRAM_BOT_TOKEN" ] || ask TELEGRAM_CHAT_ID "  Telegram chat id" "$(current TELEGRAM_CHAT_ID)"
  ask FILES_ROOT "Folder the file browser may use" "$(current FILES_ROOT)"
  FILES_ROOT="${FILES_ROOT:-/}"
fi

INSTALL_TAILSCALE=
if ! has tailscale && confirm "Tailscale is not installed. Install it (needed to reach the dashboard)?" y; then
  INSTALL_TAILSCALE=1
fi
SERVE=
confirm "Publish the dashboard on your tailnet with tailscale serve (HTTPS on port 443)?" y && SERVE=1

# --- Packages ------------------------------------------------------------------

bold "Installing packages"
packages=(git ca-certificates curl python3 tmux)
missing=()
for p in "${packages[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ ${#missing[@]} -gt 0 ]; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
fi
info "git, python3, tmux: ok"

# Node.js from NodeSource when the system one is missing or older than Vite needs.
if ! node_ok; then
  info "Installing Node.js $NODE_MAJOR from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  node_ok || fail "Node.js 20.19 or newer is needed; found $(node -v 2>/dev/null || echo none)."
fi
info "node $(node -v): ok"

if [ -n "$INSTALL_TAILSCALE" ]; then
  info "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if has tailscale && ! tailscale status >/dev/null 2>&1; then
  bold "Log this server in to Tailscale (open the link it prints)"
  sudo tailscale up
fi

# --- Code ----------------------------------------------------------------------

if [ -n "$UPDATE" ]; then
  bold "Updating $APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  bold "Downloading to $APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi

# --- Settings ------------------------------------------------------------------

TAILNET=''
if has tailscale && tailscale status >/dev/null 2>&1; then
  TAILNET="$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin).get("MagicDNSSuffix", ""))')"
fi

if [ -n "$RECONFIGURE" ]; then
  tmp="$(mktemp)"
  {
    echo "# Written by setup.sh. Re-run it to change these, or edit and: sudo systemctl restart mkd-dashboard"
    echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
    [ -z "$TAILNET" ] || echo "TAILNET=$TAILNET"
    [ "$FILES_ROOT" = / ] || echo "FILES_ROOT=$FILES_ROOT"
    [ -z "$NTFY_URL" ] || echo "NTFY_URL=$NTFY_URL"
    [ -z "$TELEGRAM_BOT_TOKEN" ] || echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"
    [ -z "$TELEGRAM_CHAT_ID" ] || echo "TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID"
  } > "$tmp"
  sudo install -m 600 -o root -g root "$tmp" "$ENV_FILE"
  rm -f "$tmp"
elif [ -n "$TAILNET" ] && ! sudo grep -q '^TAILNET=' "$ENV_FILE"; then
  echo "TAILNET=$TAILNET" | sudo tee -a "$ENV_FILE" >/dev/null
fi

# --- Service -------------------------------------------------------------------

bold "Installing the service"
sudo "$APP_DIR/deploy/install.sh" "$(whoami)"

URL="http://127.0.0.1:8090 (on the server only)"
if [ -n "$SERVE" ] && has tailscale; then
  if sudo tailscale serve status 2>/dev/null | grep -q '127.0.0.1:8090'; then
    info "Already published with tailscale serve"
  elif sudo tailscale serve status 2>/dev/null | grep -q 'https://'; then
    info "tailscale serve already publishes something on this machine; leaving it alone."
    info "Publish the dashboard yourself, e.g.: sudo tailscale serve --bg --https=8443 http://127.0.0.1:8090"
    SERVE=
  else
    sudo tailscale serve --bg http://127.0.0.1:8090 >/dev/null
  fi
  if [ -n "$SERVE" ]; then
    HOST="$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
    URL="https://$HOST/"
  fi
fi

echo
bold "Done"
info "Open: $URL"
# Only shown when it was generated, since you didn't type it yourself.
if [ -n "${GENERATED_PASSWORD:-}" ] && [ "$ADMIN_PASSWORD" = "$GENERATED_PASSWORD" ]; then
  info "Admin password: $ADMIN_PASSWORD  (stored in $ENV_FILE)"
fi
info "Your apps are in $APP_DIR/apps.json; edit them from the Apps page."
info "To update later, run the same command again."
# install.sh may have added you to the docker group; this shell doesn't have it yet.
if getent group docker >/dev/null && ! id -nG | tr ' ' '\n' | grep -qx docker; then
  info "Log out and back in once, so your shell picks up the new docker group."
fi
