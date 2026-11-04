#!/usr/bin/env bash
# Installs the dashboard as a systemd service running as your own user, so the
# web terminal and file browser act as you. Through sudo it may only run
# systemctl start/stop/restart/enable/disable for the units listed as "service"
# in apps.json, and the root helper (deploy/mkd-dashboard-helper).
#
#   sudo ./deploy/install.sh            # runs as the user who called sudo
#   sudo ./deploy/install.sh someuser
#
# On another machine that the main dashboard should control (see server/agent.js):
#
#   sudo ./deploy/install.sh --agent <listen-address> [<main-dashboard-address>]
#
# The agent listens on <listen-address>:8099 (its Tailscale or LAN address, never 0.0.0.0) and,
# if given, only accepts connections from <main-dashboard-address>.
#
# Re-run after adding or changing "service" entries in apps.json, and after
# pulling changes (it rebuilds dist/).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT=
if [ "${1:-}" = --agent ]; then
  AGENT=1
  AGENT_HOST="${2:-}"
  AGENT_ALLOW="${3:-}"
  AGENT_PORT=8099
  if ! [[ "$AGENT_HOST" =~ ^[0-9a-fA-F.:]+$ ]] || [[ "$AGENT_HOST" =~ ^(0\.0\.0\.0|::)$ ]]; then
    echo "Usage: sudo $0 --agent <listen-address> [<main-dashboard-address>] (an address of this machine, not 0.0.0.0)" >&2
    exit 1
  fi
  if [ -n "$AGENT_ALLOW" ] && ! [[ "$AGENT_ALLOW" =~ ^[0-9a-fA-F.:,]+$ ]]; then
    echo "The main dashboard's address looks wrong: $AGENT_ALLOW" >&2
    exit 1
  fi
  set -- "${SUDO_USER:-}"
fi
SERVICE_USER="${1:-${SUDO_USER:-}}"
ENV_FILE=/etc/mkd-dashboard.env
UNIT_FILE=/etc/systemd/system/mkd-dashboard.service
SUDOERS_FILE=/etc/sudoers.d/mkd-dashboard
HELPER=/usr/local/libexec/mkd-dashboard-helper

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi
if [ -z "$SERVICE_USER" ] || [ "$SERVICE_USER" = root ] || ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Run it with sudo from your own account, or pass the user to run as: sudo $0 <user>" >&2
  exit 1
fi
NODE="$(command -v node || true)"
NPM="$(command -v npm || true)"
if [ -z "$NODE" ] || [ -z "$NPM" ]; then
  echo "Node.js 20.19+ with npm is required (install it system-wide, not through nvm)" >&2
  exit 1
fi
if [ -z "$AGENT" ] && ! command -v python3 >/dev/null; then
  echo "python3 is required for the web terminal" >&2
  exit 1
fi
if [ -z "$AGENT" ] && ! command -v tmux >/dev/null; then
  echo "Note: install tmux (sudo apt install tmux) to keep terminal sessions across closed tabs and restarts."
fi
SYSTEMCTL="$(command -v systemctl)"

if ! sudo -u "$SERVICE_USER" test -w "$APP_DIR"; then
  echo "$SERVICE_USER cannot write to $APP_DIR. Clone the repo as $SERVICE_USER, e.g. into its home folder." >&2
  exit 1
fi

# Build as the service user, so node_modules/ and dist/ are not owned by root.
sudo -u "$SERVICE_USER" -H sh -c 'cd "$1" && "$2" ci --no-audit --no-fund && "$2" run build' sh "$APP_DIR" "$NPM"

# An agent has no login; the main dashboard proves itself with AGENT_TOKEN instead.
# Settings in the env file override the defaults in the unit file (HOST, PORT).
set_env() { # set_env NAME value
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  sed -i "/^$1=/d" "$ENV_FILE"
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
}
if [ -n "$AGENT" ]; then
  grep -q '^AGENT_TOKEN=' "$ENV_FILE" 2>/dev/null || set_env AGENT_TOKEN "$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
  set_env HOST "$AGENT_HOST"
  set_env PORT "$AGENT_PORT"
  set_env AGENT_ALLOW "$AGENT_ALLOW"
elif [ ! -f "$ENV_FILE" ]; then
  password="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  printf 'ADMIN_PASSWORD=%s\n' "$password" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Generated admin password, stored in $ENV_FILE: $password"
fi

# Service logs need the journal group; Docker needs the docker group (which is root-equivalent).
# An agent offers no Docker page, so it doesn't get that group.
groups="systemd-journal docker"
[ -z "$AGENT" ] || groups=systemd-journal
for group in $groups; do
  if getent group "$group" >/dev/null && ! id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx "$group"; then
    usermod -aG "$group" "$SERVICE_USER"
    echo "Added $SERVICE_USER to the $group group"
  fi
done

install -D -m 0755 -o root -g root "$APP_DIR/deploy/mkd-dashboard-helper" "$HELPER"

# The Power page reads the CPU's energy counters, which the kernel makes root-only. Let the
# dashboard user's group read just those files, now and after every boot.
UDEV_RULE=/etc/udev/rules.d/90-mkd-dashboard-power.rules
if [ -d /sys/class/powercap ]; then
  group="$(id -gn "$SERVICE_USER")"
  echo "SUBSYSTEM==\"powercap\", KERNEL==\"intel-rapl:*\", RUN+=\"/bin/chgrp $group /sys%p/energy_uj\", RUN+=\"/bin/chmod g+r /sys%p/energy_uj\"" > "$UDEV_RULE"
  udevadm control --reload
  udevadm trigger --subsystem-match=powercap --action=add
fi

# apps.json is not in git; start from the example on a fresh checkout.
if [ ! -f "$APP_DIR/apps.json" ]; then
  sudo -u "$SERVICE_USER" cp "$APP_DIR/apps.example.json" "$APP_DIR/apps.json"
  echo "Created apps.json from apps.example.json"
fi

# Same unit-name rules as server/apps.js.
units="$("$NODE" -e '
  const config = require(process.argv[1]);
  for (const group of config.groups || []) {
    for (const app of group.apps || []) {
      if (!app.service || app.url) continue;
      const unit = app.service.includes(".") ? app.service : `${app.service}.service`;
      if (/^[A-Za-z0-9@._:-]+$/.test(unit)) console.log(unit);
    }
  }
' "$APP_DIR/apps.json" | sort -u)"

tmp="$(mktemp)"
{
  echo "# Generated by $APP_DIR/deploy/install.sh from apps.json. Do not edit by hand."
  echo "$SERVICE_USER ALL=(root) NOPASSWD: $HELPER"
  for unit in $units; do
    escaped="${unit//:/\\:}"
    for action in start stop restart enable disable; do
      echo "$SERVICE_USER ALL=(root) NOPASSWD: $SYSTEMCTL $action $escaped"
    done
  done
} > "$tmp"
visudo -cf "$tmp" >/dev/null
install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"
rm -f "$tmp"
echo "Allowed units: ${units:-none}" | tr '\n' ' '
echo

sed -e "s#@APP_DIR@#$APP_DIR#" -e "s#@NODE@#$NODE#" -e "s#@USER@#$SERVICE_USER#" \
  "$APP_DIR/deploy/mkd-dashboard.service" > "$UNIT_FILE"
systemctl daemon-reload
systemctl enable mkd-dashboard.service >/dev/null
systemctl restart mkd-dashboard.service
if [ -n "$AGENT" ]; then
  echo "mkd-dashboard.service (agent) is $(systemctl is-active mkd-dashboard.service) on $AGENT_HOST:$AGENT_PORT, running as $SERVICE_USER"
  echo "Add it to servers.json of the main dashboard, with the token from: sudo grep AGENT_TOKEN $ENV_FILE"
  exit 0
fi
echo "mkd-dashboard.service is $(systemctl is-active mkd-dashboard.service) on 127.0.0.1:8090, running as $SERVICE_USER"

if id mkd-dashboard >/dev/null 2>&1; then
  echo "The old mkd-dashboard system user is no longer used; remove it with: sudo userdel mkd-dashboard"
fi
if ! tailscale serve status 2>/dev/null | grep -q '127.0.0.1:8090'; then
  echo "Publish it on your tailnet with: sudo tailscale serve --bg http://127.0.0.1:8090"
fi
