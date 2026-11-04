# mkd-dashboard

Control panel for the home lab, reachable from any of your devices over Tailscale. Everything is behind a password login.

- **Apps**: every app as a card with a live up/down indicator and a 24-hour uptime bar. Apps backed by a systemd unit can be started, stopped, restarted, enabled or disabled, and their journal viewed or followed live. Add, edit, reorder (drag and drop) and group apps from the page itself.
- **System**: CPU, memory, disk usage with 24-hour charts, swap, temperatures and uptime; alert settings and recent alerts; restart and shut down.
- **Updates**: everything that can be updated, in one list: apt packages (security updates marked), a new Ubuntu release, snaps, flatpaks, firmware (fwupd), Docker images (compared with their registry) and the dashboard's own git checkout. Update one source or everything at once; firmware and OS release upgrades are left out of "everything" on purpose. Checked every 6 hours, with an alert when security updates appear.
- **Power**: the server's power draw over 24 hours, today's and tomorrow's electricity prices for your price area (from [hvakosterstrommen.no](https://www.hvakosterstrommen.no)), and what the server costs per day, this month and per month at its current draw, in NOK. The CPU and RAM are measured (Intel RAPL); the rest of the machine is a fixed estimate (`POWER_EXTRA_WATTS`).
- **Docker**: containers grouped by Compose project with start/stop/restart for single containers or whole stacks, CPU and memory per container, live logs, and "Update" (pull newer images and recreate).
- **Files**: browse, filter and search, preview images, video, audio and PDFs, edit text files, upload (drag and drop), download files or folders as .zip, select several to move, zip or delete.
- **Terminal**: shells in the browser. With tmux on the server they are named sessions that keep running when you close the tab or lose the connection; switch between them with tabs. On phones a key bar adds Esc, Tab, Ctrl and arrows.
- **Alerts**: a push via ntfy and/or Telegram when an app is down for 2 minutes, a container stops on its own, a disk passes 90% or security updates appear, and when things recover.

It works as an app on your phone: open it in Safari or Chrome and choose *Add to Home Screen*. It follows the system light/dark setting, or pick one with the theme button.

The server (`server.js` plus `server/`) is Node.js with one runtime dependency (`ws`). The terminal uses a small Python pty helper, so nothing needs compiling. The frontend is a Vue app in `src/`, built with Vite into `dist/`, which the server serves.

## Security model

The portal runs as **your own user**, so the terminal and file browser can do whatever you can. Anyone who gets past the login has that access, so:

- The server listens on `127.0.0.1` only and is published to your tailnet with `tailscale serve`. It is never exposed to the internet or the LAN.
- One admin password (`ADMIN_PASSWORD`). After 5 wrong attempts a client is locked out for 15 minutes. Sessions last 30 days and survive restarts; signing out ends the session and its terminals.
- Root actions are limited by sudo to `systemctl start|stop|restart|enable|disable` for the units in `apps.json` (as of the last `install.sh` run) and to `/usr/local/libexec/mkd-dashboard-helper`, which only knows a fixed list of actions: apt update/upgrade, snap refresh, flatpak update, firmware update, restarting the dashboard, reboot and power off. Anything else needs `sudo` with your password in the terminal.
- Keep the unit files of those apps (and anything their `ExecStart` runs) root-owned. If your user could edit one, `sudo systemctl start` would run your code as root.
- Docker access means membership of the `docker` group, which is root-equivalent.
- `install.sh` adds a udev rule that lets your user's group read the CPU energy counters (`/sys/class/powercap/intel-rapl:*/energy_uj`) for the Power page. The kernel makes them root-only because fast, repeated reads can leak information about other programs; the dashboard reads them once a minute.

Use a long random password (the generated one is fine), and consider limiting who on the tailnet can reach the server with a Tailscale ACL, as in [deploy/prod-admin.md](deploy/prod-admin.md#5-tailscale-acl).

## Install

On a Debian or Ubuntu server, as the user the dashboard should run as (not root):

```sh
curl -fsSL https://raw.githubusercontent.com/mattkje/mkd-dashboard/HEAD/setup.sh | bash
```

It asks for the install folder, an admin password (or generates one), optional ntfy/Telegram alerts and which folder the file browser may use. Then it installs what is missing (git, Node.js 22 from NodeSource, Python, tmux, Tailscale), clones the repo, writes `/etc/mkd-dashboard.env`, installs the service and publishes it with `tailscale serve`. At the end it prints the address. Run the same command again to update; it offers to keep your settings.

## Run on the server by hand

What `setup.sh` does, step by step:

Debian or Ubuntu with systemd and Tailscale.

1. Install Node.js 20.19+ (with npm) system-wide, not through nvm, and make sure `python3` and `tmux` are installed (`sudo apt install python3 tmux`).
2. Clone the repo as your own user, e.g. into `~/mkd-dashboard`.
3. Install the service:

   ```sh
   sudo ./deploy/install.sh
   ```

   This builds the frontend (as you), and installs the `mkd-dashboard.service` unit running as you on `127.0.0.1:8090`. It also creates a generated admin password in `/etc/mkd-dashboard.env`, the root helper, and `/etc/sudoers.d/mkd-dashboard`. It adds you to the `systemd-journal` and `docker` groups if needed. Re-run it whenever you pull changes or add or change a `service` entry in `apps.json`.
4. Publish it on the tailnet:

   ```sh
   sudo tailscale serve --bg http://127.0.0.1:8090
   ```

   Then open `https://<server>.<tailnet>.ts.net/`. Tailscale provides a valid HTTPS certificate.
5. Optional, alerts: add to `/etc/mkd-dashboard.env` and `sudo systemctl restart mkd-dashboard`:

   ```sh
   NTFY_URL=https://ntfy.sh/some-long-random-topic   # subscribe to it in the ntfy app
   # and/or
   TELEGRAM_BOT_TOKEN=123456:ABC...                  # from @BotFather
   TELEGRAM_CHAT_ID=123456789                        # your chat with the bot
   ```

   Use *Send test alert* on the System page to check it. On ntfy.sh anyone who knows the topic name can read it, so pick a long random one (or run your own ntfy server and set `NTFY_TOKEN`).

Restarting the dashboard (or re-running `install.sh`) keeps tmux sessions and running apt jobs alive; only the server process itself is restarted.

### Moving from the Caddy setup

Earlier versions ran as an `mkd-dashboard` system user behind Caddy on ports 80 and 443. On the server, before or after pulling:

```sh
docker compose down   # stop the old Caddy container (run in the old checkout)
sudo userdel mkd-dashboard
```

Ports 80 and 443 are free again after that.

## Run locally

Install dependencies once with `npm install`, then use the **Frontend (Vite)** run configuration in IntelliJ, or:

```sh
npm run dev
```

Open `http://localhost:5173` and sign in with the password `dev`. For local settings (another password, alert channels), copy `env.example` to `.env` and fill in what you need; `.env` is not in git. Vite hot-reloads the frontend and also starts `server.js` on port 8090 with `--watch`, `ADMIN_PASSWORD=dev` and the fakes in `dev/`. If something already listens on 8090 (for example the **Dashboard (Node)** run configuration), Vite uses that server instead. Set `API_PORT` to use another port.

The fakes let everything work without systemd or apt (e.g. on macOS):

| Variable | Fake | What it does |
|---|---|---|
| `SYSTEMCTL` | `dev/fake-systemctl` | Starting a unit runs a dummy HTTP server on that app's port, so the up/down check reacts too |
| `JOURNALCTL` | `dev/fake-journalctl` | Prints made-up log lines |
| `HELPER` | `dev/fake-helper` | Pretends to run apt, reboot and shut down |

Dummy servers keep running after the dashboard stops; stop them from the dashboard, or with `pkill -f "http.server"`. The terminal, file browser, Docker page and system stats use your real machine (install tmux, e.g. `brew install tmux`, to try terminal sessions). History and sessions are kept in `.state/`.

To try the production build, run `npm run build`, start the server (e.g. the **Dashboard (Node)** run configuration) and open `http://localhost:8090`.

## Configure apps

Your apps live in `apps.json`, which is not in git. A fresh checkout creates it from `apps.example.json` on first start (or when `install.sh` runs).

Use the pencil button on the Apps page, or edit `apps.json` directly (also possible from the Files page). Changes apply on page refresh, no restart needed. Saving from the Apps page validates everything and keeps the previous version as `apps.json.bak`.

Local app on the same server (link uses whatever hostname you opened the dashboard with):

```json
{ "name": "Jellyfin", "description": "Media server", "port": 8096, "icon": "jellyfin", "service": "jellyfin" }
```

App on another server, e.g. over Tailscale:

```json
{ "name": "Grafana", "url": "http://other-server.tailnet-name.ts.net:3000", "icon": "grafana" }
```

| Field | Meaning |
|---|---|
| `name` | Card title (required) |
| `description` | Subtitle |
| `port` | Port on this server (local apps) |
| `scheme` | `http` (default) or `https` (local apps) |
| `path` | Optional path appended to the link, e.g. `/web` |
| `url` | Full URL (external apps, replaces `port`/`scheme`) |
| `icon` | Name from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (e.g. `gitea`), or an image URL. Falls back to a letter |
| `checkUrl` | Override the URL used for the status check. `tcp://host:port` only checks that the port accepts connections, for apps that don't speak HTTP (e.g. a Minecraft server) |
| `service` | systemd unit for a local app, e.g. `gitea` or `gitea.service`. Enables service controls and logs. Re-run `install.sh` after changing it |

An app counts as "up" if it returns any HTTP response (including 401 or a redirect).

## Environment

| Variable | Default |
|---|---|
| `PORT` | `8090` |
| `HOST` | `127.0.0.1` |
| `ADMIN_PASSWORD` | unset (login disabled) |
| `CONFIG_PATH` | `./apps.json` |
| `TAILNET` | unset. Any variable can be used in `apps.json` as `${NAME}`, e.g. `"url": "https://media.${TAILNET}:8096"` with `TAILNET=your-tailnet.ts.net`, so host names stay out of the file (secrets like passwords and tokens are never filled in) |
| `CHECK_TIMEOUT_MS` | `4000` |
| `FILES_ROOT` | `/` (the file browser can't leave this folder) |
| `STATE_DIRECTORY` | `./.state` (set by systemd to `/var/lib/mkd-dashboard`; holds login sessions and 24 hours of history) |
| `NTFY_URL`, `NTFY_TOKEN` | unset (ntfy alerts off) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset (Telegram alerts off) |
| `DOCKER`, `PYTHON`, `TMUX_BIN` | `docker`, `python3`, `tmux` |
| `SYSTEMCTL`, `JOURNALCTL`, `HELPER` | real tools; development fakes in `dev/` |
| `AGENT_TOKEN`, `AGENT_ALLOW` | unset. Set by `install.sh --agent`: the token the main dashboard must send, and the client addresses allowed to connect. See [Other servers](#other-servers-agents) |
| `SERVERS_FILE` | `./servers.json` (the other servers this dashboard controls) |
| `POWER_ZONE` | `NO1`. Price area for the Power page: `NO1` Oslo, `NO2` Kristiansand, `NO3` Trondheim, `NO4` Tromsø (no VAT), `NO5` Bergen |
| `POWER_EXTRA_WATTS` | `6`. Added to the measured CPU and RAM power for the rest of the machine (board, disks, power supply), which isn't measured |
| `POWER_GRID_NOK_PER_KWH` | `0`. Network fee per kWh including VAT, from your grid company; without it, costs are the spot price plus VAT |
| `POWER_RAPL_DIR` | `/sys/class/powercap` (development: a folder laid out the same way) |

## Other servers (agents)

The same checkout can run on your other machines as an **agent**: no web pages and no login, just the API behind the System, Apps (services), Updates and Files pages. Pick a server in the menu next to the title and those pages show that machine. Terminal, Docker, Power and alerts stay with the main dashboard, which also alerts when an agent stops answering.

Nothing stays connected between the machines: each request for a remote page is passed on to its agent (over Tailscale or the LAN), and the monitor asks every agent for its status once every 5 minutes.

On the other machine (Node.js 20.19+ and git needed), as the user it should run as:

```sh
git clone https://github.com/mattkje/mkd-dashboard.git ~/mkd-dashboard
cd ~/mkd-dashboard
# Listen on this machine's Tailscale or LAN address; only accept the main dashboard's address.
sudo ./deploy/install.sh --agent 100.x.y.z 100.a.b.c
```

The agent gets a random `AGENT_TOKEN` in its `/etc/mkd-dashboard.env` and its own `apps.json` with the services you want to control there (the `service` entries, as above; re-run the install command after changing them). Then list it in `servers.json` next to the main dashboard's `apps.json` (not in git, mode 600):

```json
[
  { "id": "prod", "name": "mkd-server-prod", "url": "http://100.x.y.z:8099", "token": "<AGENT_TOKEN>" }
]
```

Over Tailscale the connection is encrypted. Over a LAN it is plain HTTP, so anyone on that network who can watch traffic could see the token; put the machine on your tailnet if that matters. The agent only answers the routes in `server/agent.js`; root actions go through the same sudo rules and helper as the main dashboard.

## Private apps on other servers

Apps that must not be public (admin panels and the like) can be published only on the Tailscale network, with `tailscale serve` on their own server, and linked from the dashboard by their `*.ts.net` address, e.g. `"url": "https://other-server.${TAILNET}:8443/"`.

## Your own icons

Put image files in `public/icons/` (not in git) and use them as `"icon": "/icons/my-app.png"`. Run `npm run build` (or re-run the installer) after adding one. Run `python3 icons-src/app-icon.py` to redraw the dashboard's own app icon.
