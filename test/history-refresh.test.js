const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = process.env.HISTORY_SCRIPT || path.join(__dirname, '../public/history.js');
const source = fs.readFileSync(file, 'utf8');
// Exercise the actual loader, with controlled network completion order.
const loader = source.slice(source.indexOf('  async function reload() {'), source.indexOf('  // ── Period control'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const elements = new Map();
  const pending = [];
  const el = id => {
    if (!elements.has(id)) { const classes = new Set(); elements.set(id, {
      value: '30', textContent: '', hidden: false, disabled: false,
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
    }); }
    return elements.get(id);
  };
  const ctx = { console, $: el, reloadVersion: 0, stationId: 'kpft', stats: null,
    allEvents: [], streams: [], lastUptime: null, lastRangeIsAllTime: false,
    lastListeners: null, lastRollup: null, renders: 0,
    rangeDays: () => el('#f-range').value === 'all' ? 3650 : Number(el('#f-range').value),
    fetch: url => new Promise((resolve, reject) => pending.push({url, resolve, reject})),
  };
  ctx.scope = () => ctx.stationId ? '&stationId=' + ctx.stationId : '';
  for (const name of ['populateStreamFilter','populateCauseFilter','renderStorage','syncRangePills','renderOverviewRange','renderImpactHero','renderAudience','renderHeatmap','renderCauses','applyFilters']) ctx[name] = () => {};
  ctx.applyFilters = () => ctx.renders++;
  vm.createContext(ctx); vm.runInContext(loader, ctx);
  return {ctx, pending, el};
}
function respond(req, marker, status=200) {
  req.resolve({ok: status===200, status, json: async () => ({marker, streams:[{id:marker}], events:[{id:marker}]})});
}

test('every request captures the same station/range and publishes only when complete', async () => {
  const h=harness();const job=h.ctx.reload();const reqs=h.pending.splice(0);
  assert.equal(reqs.length,5);
  h.ctx.stationId='kpfk';h.el('#f-range').value='7';
  for(const r of reqs) assert.match(r.url,/days=30&stationId=kpft/);
  for(const r of reqs.slice(0,-1)) respond(r,'kpft');await tick();
  assert.equal(h.ctx.stats,null);assert.equal(h.ctx.renders,0);
  respond(reqs.at(-1),'kpft');await job;assert.equal(h.ctx.renders,1);
});

test('delayed KPFK cannot overwrite KPFT or mix its incident and audience figures', async () => {
  const h=harness();h.ctx.stationId='kpfk';const old=h.ctx.reload();const oldReq=h.pending.splice(0);
  h.ctx.stationId='kpft';const latest=h.ctx.reload();
  for(const r of h.pending.splice(0)) respond(r,'kpft');await latest;
  for(const r of oldReq) respond(r,'kpfk');await old;
  for(const key of ['stats','lastUptime','lastListeners','lastRollup']) assert.equal(h.ctx[key].marker,'kpft');
  assert.equal(h.ctx.streams[0].id,'kpft');assert.equal(h.ctx.allEvents[0].id,'kpft');assert.equal(h.ctx.renders,1);
});

test('late decoded bodies and failures do not replace a newer range', async () => {
  const h=harness();const bodies=[];const old=h.ctx.reload();
  for(const r of h.pending.splice(0)) r.resolve({ok:true,json:()=>new Promise(resolve=>bodies.push(()=>resolve({marker:'old'})))});
  await tick();h.el('#f-range').value='7';const latest=h.ctx.reload();
  for(const r of h.pending.splice(0)) respond(r,'new');await latest;bodies.forEach(fn=>fn());await old;
  assert.equal(h.ctx.stats.marker,'new');
  const failing=h.ctx.reload();const failures=h.pending.splice(0);const newer=h.ctx.reload();
  for(const r of h.pending.splice(0)) respond(r,'newer');await newer;
  failures.forEach(r=>r.reject(new Error('offline')));await failing;
  assert.equal(h.ctx.stats.marker,'newer');assert.equal(h.el('#history-load-status').hidden,true);
});

test('loading and failure conceal old figures, disable export, and allow retry', async () => {
  const h=harness();const first=h.ctx.reload();for(const r of h.pending.splice(0)) respond(r,'old');await first;
  const fail=h.ctx.reload();assert.ok(h.el('#history-view').classList.contains('history-pending'));assert.equal(h.el('#export-btn').disabled,true);
  for(const r of h.pending.splice(0)) respond(r,'bad',500);await fail;
  assert.ok(h.el('#history-view').classList.contains('history-pending'));assert.equal(h.el('#history-retry').hidden,false);
  assert.match(h.el('#history-load-message').textContent,/Could not load/);
  const retry=h.ctx.reload();for(const r of h.pending.splice(0)) respond(r,'new');await retry;
  assert.equal(h.ctx.stats.marker,'new');assert.equal(h.el('#history-view').classList.contains('history-pending'),false);assert.equal(h.el('#export-btn').disabled,false);
});

test('supplementary failures still render current incidents without old supplemental data', async () => {
  const h=harness();const job=h.ctx.reload();
  for(const r of h.pending.splice(0)) respond(r,'kpft',/\/api\/(stats|events)\?/.test(r.url)?200:503);
  await job;assert.equal(h.ctx.stats.marker,'kpft');assert.equal(h.ctx.lastListeners,null);assert.equal(h.ctx.lastUptime,null);assert.equal(h.ctx.lastRollup,null);assert.equal(h.ctx.renders,1);
});

test('All stations and All time are sent explicitly without retaining a station', async () => {
  const h=harness();h.ctx.stationId=null;h.el('#f-range').value='all';const job=h.ctx.reload();
  for(const r of h.pending.splice(0)){assert.match(r.url,/days=3650/);assert.doesNotMatch(r.url,/stationId/);respond(r,'all');}
  await job;assert.equal(h.ctx.lastRangeIsAllTime,true);
});
