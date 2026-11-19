/* Kerala Tourism social dashboard — page script. Data comes from the server's /api. */
'use strict';
(() => {
  const SCRAPED = ['instagram', 'facebook', 'youtube', 'x']; // fetched through Apify
  const PLATFORMS = [...SCRAPED, 'linkedin', 'pinterest'];
  const PNAME = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', x: 'X (Twitter)', linkedin: 'LinkedIn', pinterest: 'Pinterest', all: 'All platforms' };
  const SHORT = { ...PNAME, x: 'X' };
  const GROUP_NAME = { own: 'Your accounts', domestic: 'Domestic competitors', international: 'International competitors' };
  const H = 260;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };

  // ---------- state ----------
  const state = {
    data: null, tab: 'own', period: 'monthly',
    ownPick: null, ownPlatform: 'all', compPlatform: { domestic: 'instagram', international: 'instagram' }, compOrder: 'asc',
    editing: null, poll: null,
  };

  // ---------- formatting ----------
  const IN = new Intl.NumberFormat('en-IN');
  const fmtN = (v) => (v == null ? '—' : IN.format(v));
  const fmtC = (v) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  const fmtP = (v) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%');
  const fmtSigned = (v) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + IN.format(Math.abs(v)));
  const toDate = (s) => new Date(s + (s.length === 7 ? '-01' : s.length === 4 ? '-01-01' : '') + 'T00:00:00Z');
  const fmtDay = d3.utcFormat('%-d %b %Y');
  const keyLabel = { daily: (k) => d3.utcFormat('%-d %b')(toDate(k)), monthly: (k) => d3.utcFormat('%b ’%y')(toDate(k)), yearly: (k) => k };
  const keyTip = { daily: (k) => fmtDay(toDate(k)), monthly: (k) => d3.utcFormat('%B %Y')(toDate(k)), yearly: (k) => k };
  const cls = (v) => (v > 0 ? 'kt-up' : v < 0 ? 'kt-down' : '');
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const colors = () => d3.range(12).map((i) => css('--kt-c' + i));

  // ---------- API ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let body = {};
    try { body = await res.json(); } catch (e) {}
    if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('Sign in required'); }
    if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
    return body;
  }

  // ---------- data shaping ----------
  const accounts = (g) => (state.data ? state.data.accounts.filter((a) => !g || a.group === g) : []);
  function snapsOf(id, platform) {
    return state.data.snapshots.filter((s) => s.a === id && (platform === 'all' || s.p === platform)).sort((a, b) => a.d.localeCompare(b.d));
  }
  const periodKey = { daily: (d) => d, monthly: (d) => d.slice(0, 7), yearly: (d) => d.slice(0, 4) };
  // platforms an account is on: it has a username there, or follower counts (imported history or typed in)
  const platformsOf = (a) => PLATFORMS.filter((p) => a.handles[p] || state.data.snapshots.some((s) => s.a === a.id && s.p === p));

  // Map(periodKey -> followers): last value in each period. 'all' sums the platforms; a platform with no
  // value in a period keeps its last known value, so a missing month does not read as a drop.
  function series(id, platform, period) {
    const plats = platform === 'all' ? PLATFORMS : [platform];
    const per = plats.map((p) => { const m = new Map(); for (const s of snapsOf(id, p)) m.set(periodKey[period](s.d), s.f); return m; }).filter((m) => m.size);
    const keys = [...new Set(per.flatMap((m) => [...m.keys()]))].sort();
    const total = new Map();
    for (const m of per) {
      let cur = null;
      for (const k of keys) { if (m.has(k)) cur = m.get(k); if (cur != null) total.set(k, (total.get(k) || 0) + cur); }
    }
    const lim = { daily: 90, monthly: 24, yearly: 10 }[period];
    return new Map(keys.filter((k) => total.has(k)).slice(-lim).map((k) => [k, total.get(k)]));
  }
  // growth per period vs the previous period in the series
  function growth(ser) {
    const out = new Map(), ks = [...ser.keys()];
    ks.forEach((k, i) => { if (i) { const prev = ser.get(ks[i - 1]); const net = ser.get(k) - prev; out.set(k, { net, pct: prev ? (net / prev) * 100 : null }); } });
    return out;
  }
  // latest value and change vs about N days earlier
  function latest(id, platform) {
    const plats = platform === 'all' ? PLATFORMS : [platform];
    let value = null, date = null;
    const at = (days) => {
      let sum = 0, any = false;
      for (const p of plats) {
        const ss = snapsOf(id, p); if (!ss.length) continue;
        const last = ss[ss.length - 1];
        const target = new Date(Date.parse(last.d) - days * 864e5).toISOString().slice(0, 10);
        const old = [...ss].reverse().find((s) => s.d <= target);
        const minGap = days * 0.8 * 864e5;
        if (!old || Date.parse(last.d) - Date.parse(old.d) < minGap) return null;
        sum += old.f; any = true;
      }
      return any ? sum : null;
    };
    for (const p of plats) {
      const ss = snapsOf(id, p); if (!ss.length) continue;
      value = (value || 0) + ss[ss.length - 1].f;
      if (!date || ss[ss.length - 1].d > date) date = ss[ss.length - 1].d;
    }
    const m = at(30), y = at(365);
    return { value, date, mom: value != null && m ? ((value - m) / m) * 100 : null, yoy: value != null && y ? ((value - y) / y) * 100 : null };
  }

  // ---------- charts ----------
  function measure(strs) {
    const s = d3.select(document.body).append('svg').attr('class', 'kt-svg').style('position', 'absolute').style('visibility', 'hidden');
    const t = s.append('text').attr('class', 'kt-tick');
    let w = 0; for (const str of strs) { t.text(str); w = Math.max(w, t.node().getComputedTextLength()); }
    s.remove(); return w;
  }
  function emptyChart(box, msg) { box.replaceChildren(el('div', { class: 'kt-chart-empty', text: msg })); }

  // o = {type:'line'|'bar', keys, label, tip, series:[{name,color,values:Map,notes?:Map}], yFmt, tipFmt, area, free}
  function chart(box, o) {
    box.replaceChildren();
    const W = Math.max(260, box.clientWidth || 600);
    const root = d3.select(box);
    const svg = root.append('svg').attr('class', 'kt-svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`);
    if (o.type === 'bar') { // keep bars readable: drop the oldest periods when bars would get thinner than ~6px
      const fit = Math.max(1, Math.floor((W - 60) / (o.series.length * 7 + 6)));
      if (o.keys.length > fit) o = { ...o, keys: o.keys.slice(-fit) };
    }
    const vals = o.series.flatMap((s) => o.keys.map((k) => s.values.get(k))).filter((v) => v != null && isFinite(v));
    if (!vals.length) return emptyChart(box, 'Not enough history yet.');
    let lo = d3.min(vals), hi = d3.max(vals);
    if (o.type === 'bar' || !o.free) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    else { const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1; lo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad; hi += pad; }
    if (lo === hi) hi = lo + 1;
    const y = d3.scaleLinear([lo, hi], [H - 28, 12]).nice(5);
    const ticks = y.ticks(5);
    const ml = Math.ceil(measure(ticks.map(o.yFmt))) + 10, mr = 8;
    const x = o.type === 'bar' ? d3.scaleBand(o.keys, [ml, W - mr]).paddingInner(0.25).paddingOuter(0.1) : d3.scalePoint(o.keys, [ml + 8, W - mr - 8]).padding(o.keys.length === 1 ? 0.5 : 0);
    const xc = (k) => (o.type === 'bar' ? x(k) + x.bandwidth() / 2 : x(k));
    svg.append('g').selectAll('line').data(ticks).join('line').attr('class', 'kt-gridline').attr('x1', ml).attr('x2', W - mr).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
    svg.append('g').selectAll('text').data(ticks).join('text').attr('class', 'kt-tick').attr('x', ml - 8).attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(o.yFmt);
    const d0 = y.domain()[0], base = y(d0 <= 0 ? 0 : d0);
    svg.append('line').attr('class', 'kt-axis').attr('x1', ml).attr('x2', W - mr).attr('y1', base).attr('y2', base);
    const lw = measure(o.keys.map(o.label)) + 14;
    const step = Math.max(1, Math.ceil(lw / ((W - ml - mr) / o.keys.length)));
    const xk = o.keys.filter((k, i) => (o.keys.length - 1 - i) % step === 0);
    svg.append('g').selectAll('text').data(xk).join('text').attr('class', 'kt-tick').attr('y', H - 8).text(o.label).each(function (k) {
      const tw = this.getComputedTextLength(), cx = xc(k);
      let a = 'middle', xx = cx;
      if (cx + tw / 2 > W) { a = 'end'; xx = W; } else if (cx - tw / 2 < ml - 4) { a = 'start'; xx = Math.max(0, cx - 4); }
      d3.select(this).attr('x', xx).attr('text-anchor', a);
    });
    const marks = svg.append('g'), n = o.series.length;
    let bars = null, dots = null, rule = null;
    if (o.type === 'bar') {
      const sub = d3.scaleBand(d3.range(n), [0, x.bandwidth()]).paddingInner(n > 1 ? 0.12 : 0);
      const bw = Math.min(32, sub.bandwidth());
      const data = o.series.flatMap((s, i) => o.keys.filter((k) => s.values.get(k) != null).map((k) => ({ k, i, v: s.values.get(k), c: s.color })));
      bars = marks.selectAll('rect').data(data).join('rect')
        .attr('x', (d) => x(d.k) + sub(d.i) + (sub.bandwidth() - bw) / 2).attr('width', bw)
        .attr('y', (d) => Math.min(y(d.v), y(0))).attr('height', (d) => Math.max(1, Math.abs(y(d.v) - y(0))))
        .attr('rx', Math.min(3, bw / 2)).attr('fill', (d) => d.c);
    } else {
      rule = svg.append('line').attr('class', 'kt-rule').attr('y1', 12).attr('y2', base).style('display', 'none');
      o.series.forEach((s) => {
        const pts = o.keys.map((k) => ({ k, v: s.values.get(k) }));
        if (o.area && n === 1) {
          const gid = 'g' + Math.random().toString(36).slice(2);
          const g = svg.append('defs').append('linearGradient').attr('id', gid).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
          [[0, .26], [.25, .16], [.5, .08], [.75, .03], [1, 0]].forEach(([off, op]) => g.append('stop').attr('offset', off).style('stop-color', s.color).style('stop-opacity', op));
          marks.append('path').datum(pts).attr('fill', `url(#${gid})`).attr('d', d3.area().defined((d) => d.v != null).x((d) => x(d.k)).y0(base).y1((d) => y(d.v)));
        }
        marks.append('path').datum(pts).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
          .attr('d', d3.line().defined((d) => d.v != null).x((d) => x(d.k)).y((d) => y(d.v)));
        // single points are invisible as a line: draw a dot
        marks.selectAll(null).data(pts.filter((d, i) => d.v != null && pts[i - 1]?.v == null && pts[i + 1]?.v == null)).join('circle')
          .attr('cx', (d) => x(d.k)).attr('cy', (d) => y(d.v)).attr('r', 3).attr('fill', s.color);
      });
      dots = svg.append('g');
    }
    const tip = root.append('div').attr('class', 'kt-tip').style('display', 'none');
    const show = (k) => {
      tip.selectAll('*').remove();
      tip.append('div').attr('class', 'kt-tip-h').text(o.tip(k));
      o.series.forEach((s) => {
        const v = s.values.get(k), r = tip.append('div').attr('class', 'kt-tip-r');
        if (n > 1) r.append('span').attr('class', 'kt-sw').style('background', s.color);
        r.append('span').text(s.name);
        r.append('b').text(v == null ? '—' : (o.tipFmt || o.yFmt)(v));
        if (s.notes && s.notes.get(k) != null) r.append('span').style('color', 'var(--color-fg-muted)').text(s.notes.get(k));
      });
      tip.style('display', null);
      const tw = tip.node().offsetWidth, cx = xc(k) * (box.clientWidth / W);
      tip.style('left', (cx + 14 + tw > box.clientWidth ? Math.max(0, cx - 14 - tw) : cx + 14) + 'px');
      if (bars) bars.attr('opacity', (d) => (d.k === k ? 1 : 0.45));
      if (dots) {
        rule.style('display', null).attr('x1', x(k)).attr('x2', x(k));
        dots.selectAll('circle').data(o.series.filter((s) => s.values.get(k) != null)).join('circle').attr('cx', x(k)).attr('cy', (s) => y(s.values.get(k))).attr('r', 4).attr('fill', (s) => s.color).attr('stroke', 'var(--color-panel)').attr('stroke-width', 1.5);
      }
    };
    const hide = () => { tip.style('display', 'none'); if (bars) bars.attr('opacity', 1); if (dots) { dots.selectAll('circle').remove(); rule.style('display', 'none'); } };
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - mr).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [mx] = d3.pointer(ev);
        let i = o.type === 'bar' ? Math.floor((mx - ml) / ((W - ml - mr) / o.keys.length)) : o.keys.length === 1 ? 0 : Math.round((mx - x(o.keys[0])) / (x.step() || 1));
        show(o.keys[Math.max(0, Math.min(o.keys.length - 1, i))]);
      }).on('pointerleave', hide);
  }

  // Ranked bar chart (one bar per account, value written above each bar), as used in the comparison tabs.
  // o = {items:[{name, value, own}], fmt, axisFmt, yTitle, xTitle, order:'asc'|'desc'}
  function rankChart(box, o) {
    box.replaceChildren();
    const items = [...o.items].sort((a, b) => (o.order === 'desc' ? b.value - a.value : a.value - b.value));
    if (!items.length) return emptyChart(box, 'No data yet.');
    const avail = box.clientWidth || 600, need = items.length * 52 + 110; // narrow screens: keep bars readable and scroll sideways
    const W = Math.max(280, avail, need), RH = 380;
    const svg = d3.select(box).append('svg').attr('class', 'kt-svg kt-rank').attr('width', W > avail ? W : '100%').attr('viewBox', `0 0 ${W} ${RH}`);
    const lo = Math.min(0, d3.min(items, (d) => d.value)), hi = Math.max(0, d3.max(items, (d) => d.value)) || 1;
    // room at the bottom for names written at 45°
    const nameW = measure(items.map((d) => d.name)), mb = Math.min(150, Math.ceil(nameW * Math.SQRT1_2) + 26) + 26;
    const y0 = d3.scaleLinear([lo, hi], [RH - mb, 0]).nice(5), ticks = y0.ticks(5);
    const ml = Math.ceil(measure(ticks.map(o.axisFmt))) + 34, mr = 12;
    const x = d3.scaleBand(items.map((d) => d.name), [ml, W - mr]).paddingInner(0.3).paddingOuter(0.15);
    const bw = Math.min(56, x.bandwidth());
    // value labels: horizontal when they fit over the bar, otherwise upright
    const labW = measure(items.map((d) => o.fmt(d.value)));
    const upright = labW + 6 > x.bandwidth() + x.step() * 0.3;
    const mt = upright ? Math.ceil(labW) + 10 : 24;
    const y = y0.copy().range([RH - mb, mt]);
    const g = svg.append('g');
    g.selectAll('line').data(ticks).join('line').attr('class', 'kt-gridline').attr('x1', ml).attr('x2', W - mr).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
    g.selectAll('text').data(ticks).join('text').attr('class', 'kt-tick').attr('x', ml - 8).attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(o.axisFmt);
    svg.append('text').attr('class', 'kt-axis-title').attr('transform', `translate(12,${(mt + RH - mb) / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(o.yTitle);
    svg.append('text').attr('class', 'kt-axis-title').attr('x', (ml + W - mr) / 2).attr('y', RH - 6).attr('text-anchor', 'middle').text(o.xTitle);
    svg.append('line').attr('class', 'kt-axis').attr('x1', ml).attr('x2', W - mr).attr('y1', y(0)).attr('y2', y(0));
    const cx = (d) => x(d.name) + x.bandwidth() / 2;
    svg.append('g').selectAll('rect').data(items).join('rect')
      .attr('class', (d) => (d.own ? 'kt-bar-own' : 'kt-bar'))
      .attr('x', (d) => cx(d) - bw / 2).attr('width', bw)
      .attr('y', (d) => Math.min(y(d.value), y(0))).attr('height', (d) => Math.max(1, Math.abs(y(d.value) - y(0)))).attr('rx', 2);
    svg.append('g').selectAll('text').data(items).join('text')
      .attr('class', (d) => 'kt-bar-label' + (d.own ? ' own' : ''))
      .attr('text-anchor', (d) => (upright ? (d.value < 0 ? 'end' : 'start') : 'middle'))
      .attr('transform', (d) => {
        const ty = d.value < 0 ? y(d.value) + (upright ? 6 : 16) : y(d.value) - 6;
        return upright ? `translate(${cx(d) + 4},${ty}) rotate(-90)` : `translate(${cx(d)},${ty})`;
      })
      .text((d) => o.fmt(d.value));
    svg.append('g').selectAll('text').data(items).join('text').attr('class', 'kt-tick kt-rank-name')
      .attr('text-anchor', 'end').attr('transform', (d) => `translate(${cx(d) + 4},${y.range()[0] + 14}) rotate(-45)`).text((d) => d.name);
  }

  const PERIOD_NOTE = {
    followers: { daily: 'Followers on each day fetched, last 90 days.', monthly: 'Followers at the last fetch of each month, last 24 months.', yearly: 'Followers at the last fetch of each year.' },
    net: { daily: 'Net new followers between fetches; hover for growth %.', monthly: 'Net new followers each month; hover for growth %.', yearly: 'Net new followers each year; hover for growth %.' },
    pct: { daily: 'Growth % between fetches.', monthly: 'Growth % versus the month before.', yearly: 'Growth % versus the year before.' },
  };
  const card = (id, title, note) => el('div', { class: 'kt-card' }, el('h3', { text: title }), el('p', { class: 'kt-note', text: note }), el('div', { class: 'kt-chart', id }));
  function emptyState(msg, linkText) {
    return el('div', { class: 'kt-empty' }, el('p', {}, msg), linkText ? el('button', { class: 'kt-link', type: 'button', text: linkText, onclick: () => openTab('accounts') }) : null);
  }

  // ---------- tab: own ----------
  function renderOwn() {
    const box = $('#tab-own'); box.replaceChildren();
    const own = accounts('own');
    if (!own.length) return box.append(emptyState('No accounts yet. Add Kerala Tourism’s usernames to start tracking.', 'Add your accounts'));
    if (!own.find((a) => a.id === state.ownPick)) state.ownPick = own[0].id;
    const acct = own.find((a) => a.id === state.ownPick);
    if (own.length > 1) {
      box.append(el('div', { class: 'kt-row' }, el('span', { class: 'kt-label', text: 'Account' }),
        el('div', { class: 'kt-seg' }, own.map((a) => el('button', { type: 'button', 'aria-pressed': String(a.id === acct.id), text: a.name, onclick: () => { state.ownPick = a.id; renderOwn(); } })))));
    }
    if (!state.data.snapshots.some((s) => s.a === acct.id)) return box.append(emptyState(`No follower counts for ${acct.name} yet. Click “Refresh now” to fetch them.`));

    const L = latest(acct.id, 'all');
    box.append(el('p', { class: 'kt-note', text: `${acct.name} · latest figures ${L.date ? fmtDay(toDate(L.date)) : '—'}. Pick a platform to chart it. Changes compare with about 30 days and 12 months earlier.` }));
    const tiles = el('div', { class: 'kt-tiles' });
    const mine = platformsOf(acct);
    for (const p of ['all', ...mine]) {
      const v = latest(acct.id, p);
      tiles.append(el('button', { type: 'button', class: 'kt-tile', 'aria-pressed': String(state.ownPlatform === p), onclick: () => { state.ownPlatform = p; renderOwn(); } },
        el('span', { class: 'kt-tile-name', text: PNAME[p] }),
        el('span', { class: 'kt-num', text: fmtN(v.value) }),
        el('span', { class: 'kt-delta' }, el('span', { class: cls(v.mom), text: fmtP(v.mom) }), ' 30 days · ', el('span', { class: cls(v.yoy), text: fmtP(v.yoy) }), ' 1 year')));
    }
    box.append(tiles);
    if (state.ownPlatform !== 'all' && !mine.includes(state.ownPlatform)) state.ownPlatform = 'all';
    const plat = state.ownPlatform, per = state.period;
    box.append(el('div', { class: 'kt-grid2' }, card('own-f', `Follower count · ${PNAME[plat]}`, PERIOD_NOTE.followers[per]), card('own-g', `Follower growth · ${PNAME[plat]}`, PERIOD_NOTE.net[per])));
    // table
    const tb = el('tbody');
    for (const p of [...mine, 'all']) {
      const v = latest(acct.id, p);
      tb.append(el('tr', { class: p === 'all' ? 'kt-total kt-hl' : null },
        el('td', {}, p === 'all' || !acct.urls[p] ? PNAME[p] : el('a', { href: acct.urls[p], target: '_blank', rel: 'noopener', text: PNAME[p] })),
        el('td', { text: fmtN(v.value) }), el('td', { class: cls(v.mom), text: fmtP(v.mom) }), el('td', { class: cls(v.yoy), text: fmtP(v.yoy) })));
    }
    box.append(el('div', { class: 'kt-card' }, el('h3', { text: 'Platform breakdown' }), el('p', { class: 'kt-note', text: `${acct.name} followers by platform.` }),
      el('div', { class: 'kt-tablewrap' }, el('table', { class: 'kt-table' }, el('thead', {}, el('tr', {}, ['Platform', 'Followers', '30 days', '1 year'].map((t) => el('th', { text: t })))), tb))));

    const c0 = colors()[0];
    const ser = series(acct.id, plat, per), keys = [...ser.keys()];
    if (!keys.length) emptyChart($('#own-f'), 'No data yet.');
    else if (per === 'yearly') chart($('#own-f'), { type: 'bar', keys, label: keyLabel[per], tip: keyTip[per], series: [{ name: 'Followers', color: c0, values: ser }], yFmt: fmtC, tipFmt: fmtN });
    else chart($('#own-f'), { type: 'bar', keys, label: keyLabel[per], tip: keyTip[per], series: [{ name: 'Followers', color: c0, values: ser }], yFmt: fmtC, tipFmt: fmtN });
    const g = growth(ser), gk = [...g.keys()];
    if (!gk.length) emptyChart($('#own-g'), `Growth appears after the second ${per === 'daily' ? 'fetch' : per === 'monthly' ? 'month' : 'year'} of data.`);
    else chart($('#own-g'), { type: 'bar', keys: gk, label: keyLabel[per], tip: keyTip[per], series: [{ name: 'Net new', color: c0, values: new Map(gk.map((k) => [k, g.get(k).net])), notes: new Map(gk.map((k) => [k, fmtP(g.get(k).pct)])) }], yFmt: fmtC, tipFmt: fmtSigned });
  }

  // ---------- tabs: competitors ----------
  function renderComp(group) {
    const box = $('#tab-' + group); box.replaceChildren();
    const comps = accounts(group), own = accounts('own');
    if (!comps.length) return box.append(emptyState(`No ${group} competitors yet.`, `Add ${group} competitors`));
    const plat = state.compPlatform[group], per = state.period;
    box.append(el('div', { class: 'kt-row' }, el('span', { class: 'kt-label', text: 'Platform' }),
      el('div', { class: 'kt-seg' }, [...PLATFORMS.filter((p) => SCRAPED.includes(p) || [...own.slice(0, 1), ...comps].some((a) => platformsOf(a).includes(p))), 'all'].map((p) => el('button', { type: 'button', 'aria-pressed': String(p === plat), text: SHORT[p], onclick: () => { state.compPlatform[group] = p; renderComp(group); } }))),
      el('span', { class: 'kt-label', text: 'Order' }),
      el('div', { class: 'kt-seg' }, [['asc', 'Ascending'], ['desc', 'Descending']].map(([v, t]) => el('button', { type: 'button', 'aria-pressed': String(state.compOrder === v), text: t, onclick: () => { state.compOrder = v; renderComp(group); } })))));
    const boards = [...own.slice(0, 1), ...comps].filter((a) => plat === 'all' || platformsOf(a).includes(plat));
    const color = new Map(boards.map((a) => [a.id, a.group === 'own' ? 'var(--kt-own)' : 'var(--kt-bar)']));
    const withData = boards.filter((a) => latest(a.id, plat).value != null);
    if (!withData.length) return box.append(emptyState(`No ${PNAME[plat]} follower counts yet for these accounts. Click “Refresh now” to fetch them.`));
    const ranked = [...withData].sort((a, b) => latest(b.id, plat).value - latest(a.id, plat).value);
    const me = own[0], rank = me ? ranked.findIndex((a) => a.id === me.id) : -1;
    box.append(el('p', { class: 'kt-note' }, rank >= 0 ? [`On ${PNAME[plat]}, ${me.name} ranks `, el('b', { text: `#${rank + 1} of ${ranked.length}` }), ` against the ${group} competitors tracked.`] : `Add your own account to compare it with these competitors.`));
    const tiles = el('div', { class: 'kt-tiles' });
    for (const a of state.compOrder === 'asc' ? [...ranked].reverse() : ranked) {
      const v = latest(a.id, plat);
      const t = el('div', { class: 'kt-tile' },
        el('span', { class: 'kt-tile-name' }, el('span', { class: 'kt-sw', style: `background:${color.get(a.id)};margin-right:6px` }), a.name),
        el('span', { class: 'kt-num', text: fmtN(v.value) }),
        el('span', { class: 'kt-delta' }, el('span', { class: cls(v.mom), text: fmtP(v.mom) }), ' 30 days · ', el('span', { class: cls(v.yoy), text: fmtP(v.yoy) }), ' 1 year'));
      if (a.group === 'own') t.style.boxShadow = `inset 3px 0 0 ${color.get(a.id)}`;
      tiles.append(t);
    }
    box.append(tiles);
    const fid = 'cf-' + group, gid = 'cg-' + group;
    const asOf = d3.max(withData, (a) => latest(a.id, plat).date);
    const orderTxt = state.compOrder === 'asc' ? 'smallest to largest' : 'largest to smallest';
    const prevTxt = { daily: 'the fetch before', monthly: 'the month before', yearly: 'the year before' }[per];
    box.append(el('div', { class: 'kt-stack kt-rank-cards' },
      card(fid, `Follower count · ${PNAME[plat]}`, `Followers at the latest fetch (${fmtDay(toDate(asOf))}), ${orderTxt}. Kerala Tourism is highlighted.`),
      card(gid, `Growth rate · ${PNAME[plat]}`, `Follower growth % in the latest ${per === 'daily' ? 'fetch' : per === 'monthly' ? 'month' : 'year'} compared with ${prevTxt}, ${orderTxt}.`)));
    // table: every platform
    const tb = el('tbody'), rowsAll = [...own.slice(0, 1), ...comps];
    const cols = PLATFORMS.filter((p) => rowsAll.some((a) => platformsOf(a).includes(p)));
    for (const a of rowsAll) {
      const tot = latest(a.id, 'all');
      tb.append(el('tr', { class: a.group === 'own' ? 'kt-hl' : null }, el('td', { text: a.name }),
        cols.map((p) => el('td', {}, !platformsOf(a).includes(p) ? '—' : a.urls[p] ? el('a', { href: a.urls[p], target: '_blank', rel: 'noopener', text: fmtN(latest(a.id, p).value) }) : fmtN(latest(a.id, p).value))),
        el('td', { text: fmtN(tot.value) }), el('td', { class: cls(tot.yoy), text: fmtP(tot.yoy) })));
    }
    box.append(el('div', { class: 'kt-card' }, el('h3', { text: 'Followers by platform' }), el('p', { class: 'kt-note', text: 'Latest count for every account on every platform; 1 year compares total followers with about 12 months earlier.' }),
      el('div', { class: 'kt-tablewrap' }, el('table', { class: 'kt-table' }, el('thead', {}, el('tr', {}, ['Account', ...cols.map((p) => SHORT[p]), 'Total', '1 year'].map((t) => el('th', { text: t })))), tb))));

    const xTitle = (group === 'domestic' ? 'Domestic' : 'International') + ' Tourism Departments';
    rankChart($('#' + fid), {
      items: withData.map((a) => ({ name: a.name, value: latest(a.id, plat).value, own: a.group === 'own' })),
      fmt: fmtN, axisFmt: fmtN, yTitle: 'Followers', xTitle, order: state.compOrder,
    });
    const gItems = [];
    for (const a of withData) {
      const g = growth(series(a.id, plat, per)), ks = [...g.keys()];
      if (ks.length && g.get(ks[ks.length - 1]).pct != null) gItems.push({ name: a.name, value: Math.round(g.get(ks[ks.length - 1]).pct * 100) / 100, own: a.group === 'own' });
    }
    if (!gItems.length) emptyChart($('#' + gid), `Growth appears after the second ${per === 'daily' ? 'fetch' : per === 'monthly' ? 'month' : 'year'} of data.`);
    else rankChart($('#' + gid), { items: gItems, fmt: (v) => fmtP(v), axisFmt: (v) => d3.format('.1f')(v) + '%', yTitle: 'Growth %', xTitle, order: state.compOrder });
  }

  // ---------- tab: accounts ----------
  function lastResult(id, p) {
    const r = state.data.lastRun?.results?.find((x) => x.account === id && x.platform === p);
    return r && r.error ? r.error : null;
  }
  function renderAccounts() {
    for (const g of ['own', 'domestic', 'international']) {
      const box = $(`[data-list="${g}"]`); box.replaceChildren();
      const list = accounts(g);
      if (!list.length) { box.append(el('p', { class: 'kt-hint', text: 'None yet — add one with the form above.' })); continue; }
      const tb = el('tbody');
      const cols = PLATFORMS.filter((p) => SCRAPED.includes(p) || list.some((a) => platformsOf(a).includes(p)));
      for (const a of list) {
        tb.append(el('tr', {},
          el('td', { text: a.name }),
          cols.map((p) => {
            const ss = snapsOf(a.id, p), last = ss[ss.length - 1];
            if (!a.handles[p] && !last) return el('td', { text: '—' });
            const err = lastResult(a.id, p);
            const runDay = state.data.lastRun ? state.data.lastRun.finished.slice(0, 10) : null;
            const failedNow = err && !(last && runDay && last.d >= runDay); // a value for that day (e.g. typed in) covers the failure
            const parts = [];
            if (last) parts.push(el('span', { class: 'kt-small', text: fmtN(last.f) + (last.m ? ' · entered ' + fmtDay(toDate(last.d)) : last.h ? ' · imported, ' + fmtDay(toDate(last.d)) : '') }));
            if (failedNow) parts.push(el('span', { class: 'kt-small kt-bad', text: 'Last fetch failed', title: err }));
            else if (!last) parts.push(el('span', { class: 'kt-small', text: 'Not fetched yet' }));
            parts.push(el('button', { class: 'kt-link kt-small kt-enter', type: 'button', text: failedNow || !last ? 'Enter value' : 'Edit value', onclick: () => openManual(a, p) }));
            return el('td', {}, a.handles[p] ? el('a', { href: a.urls[p], target: '_blank', rel: 'noopener', text: a.handles[p] }) : el('span', { class: 'kt-small', text: SCRAPED.includes(p) ? 'No username (history only)' : 'Entered by hand' }), parts);
          }),
          el('td', {}, el('div', { class: 'kt-actions' },
            el('button', { class: 'kt-ghost', type: 'button', text: 'Edit', onclick: () => editAccount(a) }),
            el('button', { class: 'kt-ghost', type: 'button', text: 'Delete', onclick: () => deleteAccount(a) })))));
      }
      box.append(el('div', { class: 'kt-card kt-tablewrap' }, el('table', { class: 'kt-table kt-acct' },
        el('thead', {}, el('tr', {}, ['Name', ...cols.map((p) => SHORT[p]), ''].map((t) => el('th', { text: t })))), tb)));
    }
    $('#schedule').value = state.data.settings.schedule;
    const run = state.data.lastRun, lr = $('#last-run'); lr.replaceChildren();
    if (run) {
      const ok = run.results.filter((r) => !r.error).length, bad = run.results.filter((r) => r.error);
      lr.append(el('p', { class: 'kt-msg', text: `Last fetch ${fmtDay(new Date(run.finished))} ${d3.timeFormat('%H:%M')(new Date(run.finished))}: ${ok} updated${bad.length ? `, ${bad.length} failed` : ''}.` }));
      for (const b of bad.slice(0, 12)) {
        const a = state.data.accounts.find((x) => x.id === b.account);
        const ss = a ? snapsOf(a.id, b.platform) : [], last = ss[ss.length - 1];
        const covered = last && last.m && last.d >= run.finished.slice(0, 10);
        lr.append(el('p', { class: 'kt-msg ' + (covered ? '' : 'bad'), text: `${a ? a.name : 'Removed account'} · ${PNAME[b.platform]}: ${b.error}` + (covered ? ' — value entered by hand' : '') }));
      }
    }
  }
  function formMsg(text, kind) { const m = $('#form-msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'kt-msg ' + (kind || ''); }
  function resetForm() {
    state.editing = null; $('#acct-form').reset(); $('#form-title').textContent = 'Add an account';
    $('#form-save').textContent = 'Add account'; $('#form-cancel').hidden = true;
  }
  function editAccount(a) {
    state.editing = a.id; const f = $('#acct-form');
    f.elements.name.value = a.name; f.elements.group.value = a.group;
    for (const p of PLATFORMS) f.elements[p].value = a.handles[p] || '';
    $('#form-title').textContent = 'Edit ' + a.name; $('#form-save').textContent = 'Save changes'; $('#form-cancel').hidden = false;
    formMsg(''); f.scrollIntoView({ behavior: 'smooth', block: 'center' }); f.elements.name.focus();
  }
  async function deleteAccount(a) {
    if (!confirm(`Delete ${a.name} and all of its follower history?`)) return;
    try { state.data = await api('accounts/' + a.id, { method: 'DELETE', body: {} }); if (state.editing === a.id) resetForm(); render(); }
    catch (e) { formMsg(e.message, 'bad'); }
  }

  // ---------- typing a follower count by hand ----------
  let manualFor = null;
  function openManual(a, p) {
    manualFor = { a, p };
    const f = $('#manual-form'), d = new Date().toISOString().slice(0, 10);
    const existing = snapsOf(a.id, p).find((s) => s.d === d);
    $('#manual-title').textContent = `${a.name} · ${PNAME[p]}`;
    f.elements.date.value = d; f.elements.date.max = d;
    f.elements.followers.value = existing ? IN.format(existing.f) : '';
    $('#manual-remove').hidden = !(existing && existing.m);
    $('#manual-err').hidden = true;
    $('#manual').showModal(); f.elements.followers.focus();
  }
  async function saveManual(method) {
    const f = $('#manual-form');
    try {
      state.data = await api('snapshots', { method, body: { account: manualFor.a.id, platform: manualFor.p, date: f.elements.date.value, followers: f.elements.followers.value } });
      $('#manual').close(); render();
    } catch (e) { const m = $('#manual-err'); m.textContent = e.message; m.hidden = false; }
  }

  // ---------- page ----------
  function openTab(t) {
    state.tab = t;
    $$('[data-page]').forEach((s) => { s.hidden = s.dataset.page !== t; });
    $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    $('#period').hidden = t === 'accounts';
    try { history.replaceState(null, '', '#' + t); } catch (e) {}
    render();
  }
  function renderStatus() {
    const d = state.data, s = $('#run-status'); s.replaceChildren();
    if (d.running) s.append(el('span', { class: 'kt-spin' }), ' Fetching follower counts from Apify… this takes a few minutes.');
    else if (d.lastRun) s.append(`Last updated ${fmtDay(new Date(d.lastRun.finished))}. Next: ${d.settings.schedule === 'off' ? 'when you click Refresh now' : d.settings.schedule}.`);
    else s.append('No follower counts fetched yet.');
    $('#refresh').disabled = d.running || !d.accounts.length;
    const hn = $('#history-note'), hs = d.snapshots.filter((s) => s.h);
    hn.hidden = !hs.length;
    if (hs.length) {
      const lo = d3.min(hs, (s) => s.d), hi = d3.max(hs, (s) => s.d);
      hn.textContent = `Figures from ${d3.utcFormat('%b %Y')(toDate(lo))} to ${d3.utcFormat('%b %Y')(toDate(hi))} are imported from ${(d.settings.history || []).map((h) => h.source).join('; ') || 'an earlier record'}.`;
    }
    const own = accounts('own')[0], t = $('#takeaway'); t.replaceChildren();
    if (own) {
      const v = latest(own.id, 'all');
      const n = PLATFORMS.filter((p) => snapsOf(own.id, p).length).length;
      if (v.value != null) t.append(...[`${own.name} has `, el('b', { text: fmtN(v.value) }), ` followers across ${n} platform${n === 1 ? '' : 's'}` + (v.yoy != null ? ', ' : '.'), v.yoy != null ? el('b', { text: fmtP(v.yoy) }) : null, v.yoy != null ? ' over the last 12 months.' : null].filter((x) => x != null));
    }
  }
  function render() {
    if (!state.data) return;
    $$('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
    renderStatus();
    if (state.tab === 'own') renderOwn();
    else if (state.tab === 'accounts') renderAccounts();
    else renderComp(state.tab);
    clearTimeout(state.poll);
    if (state.data.running) state.poll = setTimeout(load, 8000);
  }
  async function load() { try { state.data = await api('data'); render(); } catch (e) { /* 401 shows login */ } }

  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#login-email').focus(); }
  async function showApp(email) {
    $('#login').hidden = true; $('#app').hidden = false; $('#who').textContent = email;
    const want = location.hash.slice(1);
    state.tab = ['own', 'domestic', 'international', 'accounts'].includes(want) ? want : 'own';
    await load(); openTab(state.tab);
  }

  // ---------- theme ----------
  const savedTheme = () => { try { return localStorage.getItem('kt-theme') || 'auto'; } catch (e) { return 'auto'; } };
  function setTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('kt-theme', t); } catch (e) {}
    $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
    render();
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (savedTheme() === 'auto') render(); });

  // ---------- events ----------
  document.addEventListener('DOMContentLoaded', async () => {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const err = $('#login-err'); err.hidden = true;
      try { const r = await api('login', { method: 'POST', body: { email: $('#login-email').value, password: $('#login-pass').value } }); $('#login-pass').value = ''; showApp(r.email); }
      catch (x) { err.textContent = x.message; err.hidden = false; }
    });
    $$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
    $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === savedTheme())));
    $('#signout').addEventListener('click', async () => { try { await api('logout', { method: 'POST', body: {} }); } catch (e) {} state.data = null; showLogin(); });
    $$('[data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
    $$('[data-period]').forEach((b) => b.addEventListener('click', () => { state.period = b.dataset.period; render(); }));
    $('#refresh').addEventListener('click', async () => { try { state.data = await api('refresh', { method: 'POST', body: {} }); render(); } catch (e) { alert(e.message); } });
    $('#schedule').addEventListener('change', async (e) => { try { state.data = await api('settings', { method: 'PUT', body: { schedule: e.target.value } }); render(); } catch (x) { alert(x.message); } });
    $('#manual-form').addEventListener('submit', (e) => { e.preventDefault(); saveManual('POST'); });
    $('#manual-cancel').addEventListener('click', () => $('#manual').close());
    $('#manual-remove').addEventListener('click', () => saveManual('DELETE'));
    $('#manual-form').elements.date.addEventListener('change', (e) => {
      if (!manualFor) return;
      const s = snapsOf(manualFor.a.id, manualFor.p).find((x) => x.d === e.target.value);
      $('#manual-remove').hidden = !(s && s.m);
      if (s) $('#manual-form').elements.followers.value = IN.format(s.f);
    });
    $('#form-cancel').addEventListener('click', () => { resetForm(); formMsg(''); });
    $('#acct-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      const body = { name: f.elements.name.value, group: f.elements.group.value, handles: Object.fromEntries(PLATFORMS.map((p) => [p, f.elements[p].value])) };
      try {
        state.data = await api(state.editing ? 'accounts/' + state.editing : 'accounts', { method: state.editing ? 'PUT' : 'POST', body });
        formMsg(`${state.editing ? 'Saved' : 'Added'} ${body.name}. Click “Refresh now” to fetch its follower counts.`, 'ok');
        resetForm(); render();
      } catch (x) { formMsg(x.message, 'bad'); }
    });
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
    try { const me = await api('me'); showApp(me.email); } catch (e) { showLogin(); }
  });
})();
