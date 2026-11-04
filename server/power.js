// Power use and its cost. Watts come from the CPU's RAPL energy counters (CPU package and RAM,
// /sys/class/powercap), sampled by the monitor once a minute; deploy/install.sh adds a udev rule
// so the dashboard user can read them. The rest of the machine (board, disks, power supply)
// isn't measured, so POWER_EXTRA_WATTS is added on top as an estimate.
// Prices are the day-ahead spot prices from hvakosterstrommen.no (free, no key), in NOK.
const fs = require('node:fs');
const path = require('node:path');
const stored = require('./state');

// Development only: point at a folder laid out like /sys/class/powercap.
const RAPL_DIR = process.env.POWER_RAPL_DIR || '/sys/class/powercap';
const ZONE = /^NO[1-5]$/.test(process.env.POWER_ZONE || '') ? process.env.POWER_ZONE : 'NO1';
const EXTRA_WATTS = Number(process.env.POWER_EXTRA_WATTS ?? 6) || 0;
// Network fee per kWh including VAT, from your grid company's bill; 0 shows spot price + VAT only.
const GRID_NOK_PER_KWH = Number(process.env.POWER_GRID_NOK_PER_KWH) || 0;
// Spot prices are without VAT; Northern Norway (NO4) pays none on electricity.
const VAT = ZONE === 'NO4' ? 0 : 0.25;
const TIME_ZONE = 'Europe/Oslo';
const PRICE_URL = 'https://www.hvakosterstrommen.no/api/v1/prices';
const KEEP_SAMPLES_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 35;
// A gap longer than this (dashboard stopped, machine asleep) is not counted as energy used.
const MAX_GAP_MS = 5 * 60 * 1000;

// samples: [t, watts] for the chart; days: { 'YYYY-MM-DD': { wh, nok } } for the costs.
const data = stored.load('power.json', { samples: [], days: {} });
let last = null; // { t, counters: { file: [uj, max] } }

// Top-level packages (intel-rapl:0) and their DRAM sub-zone; core and uncore are inside package.
function zones() {
  let names;
  try {
    names = fs.readdirSync(RAPL_DIR);
  } catch {
    return [];
  }
  return names.filter((name) => /^intel-rapl:\d+(:\d+)?$/.test(name)).flatMap((name) => {
    const dir = path.join(RAPL_DIR, name);
    let label;
    try {
      label = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim();
    } catch {
      return [];
    }
    const top = /^intel-rapl:\d+$/.test(name);
    return top || label === 'dram' ? [{ dir, label }] : [];
  });
}

function readCounters() {
  const counters = {};
  for (const zone of zones()) {
    try {
      const uj = Number(fs.readFileSync(path.join(zone.dir, 'energy_uj'), 'utf8'));
      const max = Number(fs.readFileSync(path.join(zone.dir, 'max_energy_range_uj'), 'utf8'));
      if (Number.isFinite(uj)) counters[zone.dir] = [uj, max];
    } catch {
      // Not readable (udev rule missing); reported through status().
    }
  }
  return counters;
}

// 'YYYY-MM-DD' in Norwegian time, the day prices and costs belong to.
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (ms) => dayFormat.format(new Date(ms));

// --- Prices ----------------------------------------------------------------------------------

const prices = new Map(); // day -> [{ start, end, nok }] (NOK per kWh including VAT and grid fee)
const lastTry = new Map(); // day -> ms, so a day that isn't published yet is only retried now and then

async function pricesFor(day) {
  if (prices.has(day)) return prices.get(day);
  if (Date.now() - (lastTry.get(day) || 0) < 30 * 60 * 1000) return null;
  lastTry.set(day, Date.now());
  const [year, month, date] = day.split('-');
  try {
    const res = await fetch(`${PRICE_URL}/${year}/${month}-${date}_${ZONE}.json`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null; // Tomorrow's prices come out around 13:00.
    const list = (await res.json()).map((p) => ({
      start: Date.parse(p.time_start),
      end: Date.parse(p.time_end),
      nok: p.NOK_per_kWh * (1 + VAT) + GRID_NOK_PER_KWH,
    }));
    prices.set(day, list);
    for (const old of prices.keys()) if (old < dayOf(Date.now() - 3 * 86400000)) prices.delete(old);
    return list;
  } catch (err) {
    console.error(`power prices ${day}: ${err.message}`);
    return null;
  }
}

async function priceAt(ms) {
  const list = await pricesFor(dayOf(ms));
  return list?.find((p) => ms >= p.start && ms < p.end)?.nok ?? null;
}

// --- Sampling (called by the monitor every minute) --------------------------------------------

async function sample(now) {
  const counters = readCounters();
  if (!Object.keys(counters).length) return;
  const before = last;
  last = { t: now, counters };
  if (!before || now - before.t > MAX_GAP_MS || now <= before.t) return;
  let joules = 0;
  for (const [file, [uj, max]] of Object.entries(counters)) {
    const previous = before.counters[file];
    if (!previous) continue;
    // The counter wraps around at max_energy_range_uj.
    joules += (uj >= previous[0] ? uj - previous[0] : uj + max - previous[0]) / 1e6;
  }
  const seconds = (now - before.t) / 1000;
  const watts = joules / seconds + EXTRA_WATTS;
  data.samples.push([now, Math.round(watts * 10) / 10]);
  data.samples = data.samples.filter(([t]) => t >= now - KEEP_SAMPLES_MS);

  const wh = (watts * seconds) / 3600;
  const price = await priceAt(now);
  const day = (data.days[dayOf(now)] ||= { wh: 0, nok: 0, unpriced: 0 });
  day.wh += wh;
  if (price == null) day.unpriced += wh;
  else day.nok += (wh / 1000) * price;
  const cutoff = dayOf(now - KEEP_DAYS * 86400000);
  for (const d of Object.keys(data.days)) if (d < cutoff) delete data.days[d];
}

function save() {
  stored.save('power.json', data);
}

// --- Page ------------------------------------------------------------------------------------

function readable() {
  const all = zones();
  if (!all.length) return 'none';
  return Object.keys(readCounters()).length ? 'ok' : 'denied';
}

async function status() {
  const now = Date.now();
  const today = dayOf(now);
  const tomorrow = dayOf(now + 86400000);
  const [todayPrices, tomorrowPrices] = await Promise.all([pricesFor(today), pricesFor(tomorrow)]);
  const recent = data.samples.filter(([t]) => t >= now - 60 * 60 * 1000);
  const average = (list) => (list.length ? list.reduce((sum, [, w]) => sum + w, 0) / list.length : null);
  const day24 = average(data.samples);
  const nowPrice = todayPrices?.find((p) => now >= p.start && now < p.end)?.nok ?? null;
  const priceAverage = todayPrices?.length ? todayPrices.reduce((s, p) => s + p.nok, 0) / todayPrices.length : null;
  const days = Object.entries(data.days)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, d]) => ({ day, kwh: d.wh / 1000, nok: d.nok, unpriced: d.unpriced > 0.5 }));
  const thisMonth = days.filter((d) => d.day.slice(0, 7) === today.slice(0, 7));
  return {
    sensor: readable(),
    zone: ZONE,
    vat: VAT,
    gridFee: GRID_NOK_PER_KWH,
    extraWatts: EXTRA_WATTS,
    watts: data.samples.at(-1)?.[1] ?? null,
    hourAverage: average(recent),
    dayAverage: day24,
    samples: data.samples.map(([t, w]) => ({ t, w })),
    price: { now: nowPrice, todayAverage: priceAverage, today: todayPrices ?? [], tomorrow: tomorrowPrices ?? [] },
    days,
    month: { kwh: thisMonth.reduce((s, d) => s + d.kwh, 0), nok: thisMonth.reduce((s, d) => s + d.nok, 0) },
    // A 30-day month at the last 24 hours' average draw and today's average price.
    monthEstimate: day24 != null && priceAverage != null
      ? { kwh: (day24 * 24 * 30) / 1000, nok: ((day24 * 24 * 30) / 1000) * priceAverage }
      : null,
  };
}

module.exports = { sample, save, status };
