<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import EmptyState from '../components/EmptyState.vue';
import Sparkline from '../components/Sparkline.vue';
import { getJson } from '../api.js';

const REFRESH_MS = 60000;

const power = ref(null);
const error = ref('');
const hover = ref(null);

const nok = new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nokWhole = new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

const watts = (w) => (w == null ? '—' : `${w < 10 ? w.toFixed(1) : Math.round(w)} W`);
const kwh = (n) => `${n < 10 ? n.toFixed(2) : n.toFixed(1)} kWh`;
const ore = (perKwh) => (perKwh == null ? '—' : `${Math.round(perKwh * 100)} øre`);
const money = (n) => (n >= 100 ? nokWhole.format(n) : nok.format(n));

const ZONES = { NO1: 'Øst-Norge', NO2: 'Sør-Norge', NO3: 'Midt-Norge', NO4: 'Nord-Norge', NO5: 'Vest-Norge' };

const today = computed(() => power.value?.days[0]?.day === dayKey(Date.now()) ? power.value.days[0] : null);
const chartMax = computed(() => Math.max(5, ...(power.value?.samples ?? []).map((s) => s.w)) * 1.15);
const points = computed(() => (power.value?.samples ?? []).map((s) => ({ t: s.t, v: s.w })));

// Today's and tomorrow's prices as one bar chart, the current period highlighted.
const bars = computed(() => {
  const p = power.value?.price;
  if (!p) return [];
  const list = [...p.today, ...p.tomorrow];
  const max = Math.max(...list.map((b) => b.nok), 0.01);
  const now = Date.now();
  return list.map((b) => ({ ...b, height: Math.max(2, (b.nok / max) * 100), now: now >= b.start && now < b.end, past: b.end <= now }));
});

// Typical energy per use, for the "best time" tips. A shower's energy is the water heater
// reheating the water afterwards, so its timing matters as much as the shower itself.
const CHORES = [
  { name: 'Shower', detail: '10 minutes, the water heater reheating after', kwh: 2.5, minutes: 60 },
  { name: 'Laundry', detail: '40 °C wash', kwh: 0.9, minutes: 120 },
  { name: 'Dishwasher', detail: 'normal program', kwh: 1, minutes: 120 },
  { name: 'Tumble dryer', detail: 'full load', kwh: 2.5, minutes: 120 },
  { name: 'Oven', detail: '1 hour at 200 °C', kwh: 1.5, minutes: 60 },
];

// Average price over [start, start + minutes), or null when the prices don't reach that far.
function windowPrice(list, start, minutes) {
  const end = start + minutes * 60000;
  if (!list.length || end > list.at(-1).end) return null;
  let sum = 0;
  for (const p of list) {
    const overlap = Math.min(end, p.end) - Math.max(start, p.start);
    if (overlap > 0) sum += p.nok * overlap;
  }
  return sum / (end - start);
}

// For each chore: the cheapest start from now on (now, or the start of a later price period),
// and what it costs compared with starting now.
const chores = computed(() => {
  const p = power.value?.price;
  if (!p) return [];
  const list = [...p.today, ...p.tomorrow];
  const now = Date.now();
  return CHORES.map((chore) => {
    const starts = [now, ...list.map((b) => b.start).filter((t) => t > now)];
    let best = null;
    for (const start of starts) {
      const price = windowPrice(list, start, chore.minutes);
      if (price != null && (!best || price < best.price - 1e-9)) best = { start, price };
    }
    const nowPrice = windowPrice(list, now, chore.minutes);
    if (!best || nowPrice == null) return { ...chore, best: null };
    return {
      ...chore,
      best,
      isNow: best.start === now,
      cost: chore.kwh * best.price,
      saving: chore.kwh * (nowPrice - best.price),
      nowCost: chore.kwh * nowPrice,
    };
  });
});

const relativeDay = (ms) => (dayKey(ms) === dayKey(Date.now()) ? 'today' : 'tomorrow');

function dayKey(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

async function load() {
  try {
    power.value = await getJson('/api/power');
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
}

let timer;
onMounted(() => {
  load();
  timer = setInterval(load, REFRESH_MS);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="power">
    <EmptyState v-if="error && !power" error title="Could not load power use" :text="error" />
    <template v-else-if="power">
      <p v-if="power.sensor === 'denied'" class="banner bad">
        The energy counters aren't readable yet. Re-run <code>sudo deploy/install.sh</code>, which allows the dashboard to read them.
      </p>
      <p v-else-if="power.sensor === 'none'" class="banner">
        This machine has no Intel RAPL energy counters, so its power use can't be measured.
      </p>

      <section class="tiles">
        <div class="panel tile">
          <span class="label">Now</span>
          <strong>{{ watts(power.watts) }}</strong>
          <span class="muted small">{{ power.hourAverage != null ? `${watts(power.hourAverage)} average last hour` : 'Measuring…' }}</span>
        </div>
        <div class="panel tile">
          <span class="label">Today</span>
          <strong>{{ today ? money(today.nok) : '—' }}</strong>
          <span class="muted small">{{ today ? kwh(today.kwh) : 'No data yet' }}</span>
        </div>
        <div class="panel tile">
          <span class="label">This month</span>
          <strong>{{ money(power.month.nok) }}</strong>
          <span class="muted small">{{ kwh(power.month.kwh) }} so far</span>
        </div>
        <div class="panel tile">
          <span class="label">Per month</span>
          <strong>{{ power.monthEstimate ? money(power.monthEstimate.nok) : '—' }}</strong>
          <span class="muted small">{{ power.monthEstimate ? `${kwh(power.monthEstimate.kwh)} at ${watts(power.dayAverage)}` : 'Estimate after a few minutes' }}</span>
        </div>
      </section>

      <section class="panel">
        <h3>Power draw <span class="muted sub">· last 24 hours</span></h3>
        <Sparkline :points="points" :max="chartMax" :format="watts" class="draw" />
        <p class="muted small note">
          CPU and RAM are measured; {{ power.extraWatts }} W is added for the rest of the machine (board, disks, power supply).
          Set <code>POWER_EXTRA_WATTS</code> to match a wall meter.
        </p>
      </section>

      <section class="panel">
        <div class="price-head">
          <h3>Electricity price <span class="muted sub">· {{ power.zone }} {{ ZONES[power.zone] }}</span></h3>
          <span class="muted small">
            Now <strong class="price-now">{{ ore(power.price.now) }}</strong> per kWh
            <template v-if="power.price.todayAverage != null"> · today's average {{ ore(power.price.todayAverage) }}</template>
          </span>
        </div>
        <div v-if="bars.length" class="bars" @pointerleave="hover = null">
          <div
              v-for="b in bars"
              :key="b.start"
              class="bar"
              :class="{ now: b.now, past: b.past, day2: b.start >= (power.price.tomorrow[0]?.start ?? Infinity) }"
              @pointerenter="hover = b"
          ><i :style="{ height: `${b.height}%` }"></i></div>
        </div>
        <p v-else class="muted">Prices couldn't be loaded from hvakosterstrommen.no.</p>
        <p class="muted small note">
          <template v-if="hover">{{ hourFormat.format(hover.start) }}–{{ hourFormat.format(hover.end) }}: {{ ore(hover.nok) }} per kWh.</template>
          <template v-else>
            Spot price{{ power.vat ? ' plus 25% VAT' : ' (no VAT in Nord-Norge)' }}<template v-if="power.gridFee"> plus {{ ore(power.gridFee) }} grid fee</template><template v-else>, without grid fee (set <code>POWER_GRID_NOK_PER_KWH</code>)</template>.
            <template v-if="power.price.tomorrow.length">Tomorrow is shown after today.</template>
            <template v-else>Tomorrow's prices come out around 13:00.</template>
          </template>
        </p>
      </section>

      <section v-if="chores.some((c) => c.best)" class="panel">
        <h3>Best time to <span class="muted sub">· {{ power.price.tomorrow.length ? 'until tomorrow night' : 'until midnight' }}</span></h3>
        <div class="chores">
          <div v-for="c in chores.filter((c) => c.best)" :key="c.name" class="chore">
            <div class="chore-name">
              <strong>{{ c.name }}</strong>
              <span class="muted small">{{ c.detail }} · about {{ c.kwh }} kWh</span>
            </div>
            <div class="chore-when">
              <strong :class="{ 'now-text': c.isNow }">{{ c.isNow ? 'Now' : `${hourFormat.format(c.best.start)} ${relativeDay(c.best.start)}` }}</strong>
              <span class="muted small">
                {{ money(c.cost) }}<template v-if="c.saving >= 0.05"> · saves {{ money(c.saving) }} vs now</template><template v-else-if="!c.isNow"> · about the same as now</template>
              </span>
            </div>
          </div>
        </div>
        <p class="muted small note">
          Uses typical energy per use and the prices above<template v-if="!power.price.tomorrow.length">; later times show up once tomorrow's prices are out (around 13:00)</template>.
        </p>
      </section>

      <section v-if="power.days.length" class="panel">
        <h3>Cost per day</h3>
        <table class="days">
          <tr v-for="d in power.days.slice(0, 31)" :key="d.day">
            <td>{{ dayFormat.format(new Date(`${d.day}T12:00:00`)) }}</td>
            <td class="num muted">{{ kwh(d.kwh) }}</td>
            <td class="num">{{ money(d.nok) }}<span v-if="d.unpriced" class="muted" title="Part of the day had no price, so its cost is missing"> *</span></td>
          </tr>
        </table>
      </section>
    </template>
    <template v-else>
      <div class="skeleton" style="height: 110px"></div>
      <div class="skeleton" style="height: 220px"></div>
    </template>
  </div>
</template>

<style scoped>
.power { display: grid; gap: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
.tile { display: grid; gap: 4px; }
.tile .label { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.tile strong { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.sub { text-transform: none; letter-spacing: 0; font-weight: 500; }
.draw { height: 120px; }
.note { margin: 12px 0 0; }
.price-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; margin-bottom: 14px; }
.price-head h3 { margin: 0; }
.price-now { color: var(--text); }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 120px; }
.bar { display: flex; flex: 1; align-items: flex-end; height: 100%; min-width: 0; cursor: crosshair; }
.bar i { display: block; width: 100%; border-radius: 3px 3px 0 0; background: color-mix(in srgb, var(--accent) 55%, transparent); }
.bar.past i { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.bar.day2 i { background: color-mix(in srgb, var(--muted) 40%, transparent); }
.bar.now i { background: var(--accent); }
.bar:hover i { outline: 1px solid var(--text); }
.chores { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0 28px; }
.chore { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
.chore-name, .chore-when { display: grid; gap: 1px; }
.chore-when { text-align: right; white-space: nowrap; }
.chore strong { font-weight: 550; }
.now-text { color: var(--up); }
.days { width: 100%; border-collapse: collapse; font-size: 14px; }
.days td { padding: 6px 0; border-top: 1px solid var(--line); }
.days tr:first-child td { border-top: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.days td.num:last-child { width: 110px; }
</style>
