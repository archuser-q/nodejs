/**
 * Thực nghiệm so sánh các chế độ ghép cặp (phục vụ chương Thực nghiệm của báo cáo).  [Thành viên B]
 *
 * Không cần DB: dùng ĐÚNG hàm điểm (src/algorithms/scoring.js — 5 tiêu chí như web quản trị),
 * Hungarian, Greedy và Union-Find (src/algorithms/*) mà hệ thống thật đang chạy.
 *
 * Phần A — Bài toán gán tĩnh (1 thời điểm có n đơn chờ, n thợ rảnh):
 *   tổng điểm & số cặp của Greedy (theo thứ tự đến) so với Hungarian (tối ưu toàn cục),
 *   thời gian chạy theo kích thước để minh hoạ độ phức tạp O(n³).
 * Phần B — Mô phỏng vận hành theo thời gian (sự kiện rời rạc, bước 1 giây):
 *   đơn đến theo Poisson; thợ có thể không phản hồi (offer hết hạn), hoặc nhận/từ chối sau vài giây;
 *   thợ bận trong thời gian di chuyển + sửa. Ngoài thời gian chờ ghép còn đo "thợ đến nơi" (chờ ghép +
 *   di chuyển) vì gửi cho nhiều thợ thì ghép nhanh hơn nhưng thợ thắng chưa chắc là thợ gần nhất.
 *   So sánh instant k=1/k=3, batch W=5/10/20/30 s, auto k=1/2/3 (mỗi nhịp 2 s: đơn đứng riêng -> top-k, nhóm tranh chấp -> Hungarian).
 *   Mỗi cấu hình chạy trên CÙNG dữ liệu đầu vào (cùng dòng đơn, cùng quyết định của thợ) với nhiều hạt giống,
 *   báo cáo trung bình ± khoảng tin cậy 95%.
 *
 *   npm run benchmark                    # mặc định (~15 giây)
 *   npm run benchmark -- --quick         # chạy nhanh để thử
 *   npm run benchmark -- --seeds 20 --out ket-qua   # lưu CSV + Markdown
 *   npm run benchmark -- --ignore 0 --accept 0.85    # đổi giả định hành vi thợ (phân tích độ nhạy)
 */
import fs from 'fs';
import path from 'path';
import { criteriaOf } from '../src/algorithms/scoring.js';
import { hungarianMax, totalScore } from '../src/algorithms/hungarian.js';
import { greedyInOrder } from '../src/algorithms/greedy.js';
import { competitionGroups } from '../src/algorithms/grouping.js';

const CONFIG = { w_distance: 0.35, w_trust: 0.3, w_skill: 0.15, w_acceptance: 0.1, w_workload: 0.1, max_radius_km: 5 };
const CITY_RADIUS_KM = 8;
const SPEED_KMH = 20; // xe máy trong phố

// ── Số ngẫu nhiên có hạt giống ──────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const gamma = (k) => {
    // Marsaglia–Tsang, k >= 1
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x;
      let v;
      do {
        x = normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v ** 3;
      const u = next();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  return {
    next,
    uniform: (a, b) => a + next() * (b - a),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    expo: (rate) => -Math.log(1 - next()) / rate,
    beta: (a, b) => {
      const x = gamma(a);
      return x / (x + gamma(b));
    },
  };
}

const randPoint = (r, radius) => {
  const d = radius * Math.sqrt(r.next());
  const b = r.uniform(0, 2 * Math.PI);
  return [d * Math.cos(b), d * Math.sin(b)]; // toạ độ phẳng (km) quanh tâm thành phố
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function makeWorkers(r, n) {
  return Array.from({ length: n }, (_, id) => ({
    id,
    pos: randPoint(r, CITY_RADIUS_KM),
    trust: Math.min(0.99, Math.max(0.3, r.beta(8, 2))),
    skillYears: r.int(0, 15),
    acceptance: r.uniform(0.6, 1),
    jobsToday: 0,
    busyUntil: 0,
    offerUntil: -1,
  }));
}

/** Điểm phù hợp đơn–thợ: đúng công thức hệ thống thật (null = ngoài bán kính) */
function pairScore(pos, w) {
  const d = dist(pos, w.pos);
  if (d > CONFIG.max_radius_km) return null;
  const c = criteriaOf(
    { distance_m: d * 1000, trust_score: w.trust, skill_years: w.skillYears, acceptance_rate: w.acceptance, jobs_today: w.jobsToday },
    CONFIG.max_radius_km,
  );
  return CONFIG.w_distance * c.distance + CONFIG.w_trust * c.trust + CONFIG.w_skill * c.skill + CONFIG.w_acceptance * c.acceptance + CONFIG.w_workload * c.workload;
}

// ── Thống kê ────────────────────────────────────────────────────────────────
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const T95 = { 1: 12.71, 2: 4.3, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 15: 2.13, 20: 2.09, 30: 2.04 };
const t95 = (df) => T95[df] ?? T95[Object.keys(T95).map(Number).filter((k) => k <= df).pop()] ?? 1.96;
/** nửa độ rộng khoảng tin cậy 95% của giá trị trung bình (phân phối t) */
function ci95(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return (t95(xs.length - 1) * sd) / Math.sqrt(xs.length);
}
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// ═════════════════════════════════════════════════════════════════════════
// Phần A: bài toán gán tĩnh
// ═════════════════════════════════════════════════════════════════════════

/** Thời gian chạy (ms): lấy nhỏ nhất của 5 lần chạy lại để bớt nhiễu do GC / JIT / tiến trình khác */
function timeOf(fn, times = 5) {
  let best = Infinity;
  for (let i = 0; i < times; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

function partA(sizes, reps, seed) {
  const rows = [];
  for (const n of sizes) {
    const r = rng(seed + n);
    const gs = [];
    const hs = [];
    const gm = [];
    const hm = [];
    const gt = [];
    const ht = [];
    for (let k = 0; k < reps(n); k++) {
      const workers = makeWorkers(r, n);
      const orders = Array.from({ length: n }, () => randPoint(r, CITY_RADIUS_KM));
      const matrix = orders.map((o) => workers.map((w) => pairScore(o, w)));
      const g = greedyInOrder(matrix);
      const h = hungarianMax(matrix);
      gt.push(timeOf(() => greedyInOrder(matrix)));
      ht.push(timeOf(() => hungarianMax(matrix)));
      gs.push(totalScore(matrix, g));
      hs.push(totalScore(matrix, h));
      gm.push(g.length);
      hm.push(h.length);
    }
    const g = mean(gs);
    const hh = mean(hs);
    rows.push({
      'n (đơn = thợ)': n,
      'số lần chạy': reps(n),
      'Greedy tổng điểm': round(g),
      'Hungarian tổng điểm': round(hh),
      'cải thiện %': round(((hh - g) / g) * 100, 2),
      'Greedy số cặp': round(mean(gm), 1),
      'Hungarian số cặp': round(mean(hm), 1),
      'Greedy ms': round(mean(gt), 3),
      'Hungarian ms': round(mean(ht), 2),
    });
    console.log(`  A n=${n}: greedy=${round(g)} hungarian=${round(hh)} (+${rows.at(-1)['cải thiện %']}%), hungarian ${rows.at(-1)['Hungarian ms']} ms`);
  }
  return rows;
}

// ═════════════════════════════════════════════════════════════════════════
// Phần B: mô phỏng vận hành theo thời gian
// ═════════════════════════════════════════════════════════════════════════

function simulate(cfg, { nWorkers, ratePerMin, minutes, acceptProb, ignoreProb, seed, timeout = 60, maxWait = 900 }) {
  const r = rng(seed);
  const workers = makeWorkers(r, nWorkers);
  // Sinh trước dòng đơn (Poisson) + thời gian sửa của từng đơn để mọi cấu hình dùng CÙNG dữ liệu đầu vào
  const arrivals = [];
  for (let t = r.expo(ratePerMin / 60); t <= minutes * 60; t += r.expo(ratePerMin / 60)) {
    arrivals.push({
      id: arrivals.length,
      pos: randPoint(r, CITY_RADIUS_KM),
      created: t,
      jobSec: r.uniform(30, 90) * 60, // 30–90 phút sửa
      offered: new Set(),
      live: new Map(),
      offers: 0,
      matchedAt: null,
    });
  }
  // Phản ứng của thợ với từng cặp (đơn, thợ) là hàm xác định của (hạt giống, đơn, thợ) — không phụ thuộc thứ tự
  // gửi offer — nên mọi cấu hình gặp đúng cùng một quyết định khi mời cùng một thợ cho cùng một đơn.
  //   ignoreProb: thợ không phản hồi (offer hết hạn sau `timeout` giây); còn lại phản hồi sau 3–25 s,
  //   nhận với xác suất acceptProb.
  const decision = (o, w) => {
    const pr = rng((Math.imul(seed, 0x9e3779b1) ^ Math.imul(o.id + 1, 0x85ebca6b) ^ Math.imul(w.id + 1, 0xc2b2ae35)) >>> 0);
    pr.next();
    if (pr.next() < ignoreProb) return [Infinity, false];
    return [pr.uniform(3, 25), pr.next() < acceptProb];
  };
  const free = (w, now) => w.busyUntil <= now && w.offerUntil < now;
  const send = (o, w, s, now) => {
    const [delay, accept] = decision(o, w);
    o.live.set(w.id, [now + Math.min(delay, timeout), accept && delay <= timeout, s]);
    o.offered.add(w.id);
    o.offers += 1;
    w.offerUntil = now + timeout;
  };
  const candidates = (o, now) => {
    const row = new Map();
    for (const w of workers) {
      if (o.offered.has(w.id) || !free(w, now)) continue;
      const s = pairScore(o.pos, w);
      if (s !== null) row.set(w.id, s);
    }
    return row;
  };
  const topK = (o, row, k) =>
    [...row.entries()].sort((a, b) => b[1] - a[1] || dist(o.pos, workers[a[0]].pos) - dist(o.pos, workers[b[0]].pos)).slice(0, k);

  let pending = [];
  let computeMs = 0;
  let decisionsMade = 0;
  let idx = 0;
  const horizon = minutes * 60 + maxWait + 60;
  for (let now = 0; now < horizon; now++) {
    while (idx < arrivals.length && arrivals[idx].created <= now) pending.push(arrivals[idx++]);

    // 1. Phản hồi offer: ai nhận sớm nhất thì được đơn
    for (const o of pending) {
      if (!o.live.size) continue;
      const due = [...o.live.entries()].filter(([, [t]]) => t <= now);
      const winners = due.filter(([, [, acc]]) => acc).sort((a, b) => a[1][0] - b[1][0]);
      if (winners.length) {
        const [wid, [, , s]] = winners[0];
        const w = workers[wid];
        o.matchedAt = now;
        o.worker = wid;
        o.score = s;
        o.pickupKm = dist(o.pos, w.pos);
        o.travelSec = (o.pickupKm / SPEED_KMH) * 3600;
        w.busyUntil = now + o.travelSec + o.jobSec;
        w.pos = o.pos;
        w.jobsToday += 1;
        for (const other of o.live.keys()) workers[other].offerUntil = -1;
        o.live.clear();
      } else {
        for (const [wid] of due) {
          workers[wid].offerUntil = -1;
          o.live.delete(wid);
        }
      }
    }
    pending = pending.filter((o) => {
      if (o.matchedAt !== null) return false;
      if (now - o.created > maxWait) {
        for (const wid of o.live.keys()) workers[wid].offerUntil = -1;
        o.live.clear();
        return false;
      }
      return true;
    });

    // 2. Ra quyết định ghép
    if (cfg.mode === 'instant') {
      for (const o of pending) {
        if (o.live.size) continue;
        const t0 = performance.now();
        const best = topK(o, candidates(o, now), cfg.k);
        computeMs += performance.now() - t0;
        decisionsMade++;
        for (const [wid, s] of best) send(o, workers[wid], s, now);
      }
    } else if (now % cfg.window === 0) {
      const pool = pending.filter((o) => !o.live.size);
      if (!pool.length) continue;
      const t0 = performance.now();
      const rows = pool.map((o) => candidates(o, now));
      const plan = [];
      if (cfg.mode === 'auto') {
        for (const g of competitionGroups(rows.map((row) => [...row.keys()]))) {
          if (g.length === 1) {
            for (const [wid, s] of topK(pool[g[0]], rows[g[0]], cfg.k)) plan.push([pool[g[0]], workers[wid], s]);
          } else {
            const wids = [...new Set(g.flatMap((i) => [...rows[i].keys()]))];
            const matrix = g.map((i) => wids.map((wid) => rows[i].get(wid) ?? null));
            for (const [aa, bb] of hungarianMax(matrix)) plan.push([pool[g[aa]], workers[wids[bb]], matrix[aa][bb]]);
          }
        }
      } else {
        const wids = [...new Set(rows.flatMap((row) => [...row.keys()]))];
        const matrix = rows.map((row) => wids.map((wid) => row.get(wid) ?? null));
        if (wids.length) for (const [i, j] of hungarianMax(matrix)) plan.push([pool[i], workers[wids[j]], matrix[i][j]]);
      }
      computeMs += performance.now() - t0;
      decisionsMade++;
      for (const [o, w, s] of plan) send(o, w, s, now);
    }
  }

  const done = arrivals.filter((o) => o.matchedAt !== null);
  const waits = done.map((o) => o.matchedAt - o.created).sort((x, y) => x - y);
  const pct = (p) => (waits.length ? waits[Math.min(waits.length - 1, Math.floor(p * waits.length))] : 0);
  return {
    orders: arrivals.length,
    matched_pct: arrivals.length ? (done.length / arrivals.length) * 100 : 0,
    wait_avg: mean(waits),
    wait_p50: pct(0.5),
    wait_p90: pct(0.9),
    score_avg: mean(done.map((o) => o.score)),
    score_total: done.reduce((s, o) => s + o.score, 0),
    pickup_km: mean(done.map((o) => o.pickupKm)),
    // khách chờ tới khi thợ đến nơi = chờ ghép + thời gian di chuyển của thợ được ghép
    arrive_min: mean(done.map((o) => (o.matchedAt - o.created + o.travelSec) / 60)),
    offers_per_order: mean(arrivals.map((o) => o.offers)),
    compute_ms: decisionsMade ? computeMs / decisionsMade : 0,
  };
}

const CONFIGS = [
  { name: 'instant k=1', mode: 'instant', k: 1 },
  { name: 'instant k=3', mode: 'instant', k: 3 },
  { name: 'batch W=5s', mode: 'batch', window: 5 },
  { name: 'batch W=10s', mode: 'batch', window: 10 },
  { name: 'batch W=20s', mode: 'batch', window: 20 },
  { name: 'batch W=30s', mode: 'batch', window: 30 },
  { name: 'auto k=1', mode: 'auto', k: 1, window: 2 },
  { name: 'auto k=2', mode: 'auto', k: 2, window: 2 },
  { name: 'auto k=3', mode: 'auto', k: 3, window: 2 },
];

function partB(scenarios, { minutes, acceptProb, ignoreProb, seeds }) {
  const rows = [];
  for (const [label, nWorkers, ratePerMin] of scenarios) {
    for (const cfg of CONFIGS) {
      const runs = seeds.map((seed) => simulate(cfg, { nWorkers, ratePerMin, minutes, acceptProb, ignoreProb, seed }));
      const m = (k) => mean(runs.map((x) => x[k]));
      const c = (k) => ci95(runs.map((x) => x[k]));
      rows.push({
        'kịch bản': label,
        'số thợ': nWorkers,
        'đơn/phút': ratePerMin,
        'cấu hình': cfg.name,
        'số đơn TB': round(m('orders'), 1),
        'tỷ lệ ghép %': `${round(m('matched_pct'), 1)} ± ${round(c('matched_pct'), 1)}`,
        'chờ TB (s)': `${round(m('wait_avg'), 1)} ± ${round(c('wait_avg'), 1)}`,
        'chờ P50 (s)': round(m('wait_p50'), 1),
        'chờ P90 (s)': round(m('wait_p90'), 1),
        'điểm TB': `${round(m('score_avg'), 4)} ± ${round(c('score_avg'), 4)}`,
        'quãng đường TB (km)': `${round(m('pickup_km'), 2)} ± ${round(c('pickup_km'), 2)}`,
        'thợ đến nơi TB (phút)': `${round(m('arrive_min'), 2)} ± ${round(c('arrive_min'), 2)}`,
        'offer/đơn': round(m('offers_per_order'), 2),
        'tính toán ms/lần': round(m('compute_ms'), 3),
      });
      const x = rows.at(-1);
      console.log(`  B [${label}] ${cfg.name.padEnd(12)} ghép ${x['tỷ lệ ghép %']}% | chờ TB ${x['chờ TB (s)']}s | điểm TB ${x['điểm TB']} | ${x['quãng đường TB (km)']} km | đến nơi ${x['thợ đến nơi TB (phút)']} phút`);
    }
  }
  return rows;
}

// ── Xuất kết quả ────────────────────────────────────────────────────────────
const toMarkdown = (rows) => {
  const keys = Object.keys(rows[0]);
  return [`| ${keys.join(' | ')} |`, `|${'---|'.repeat(keys.length)}`, ...rows.map((r) => `| ${keys.map((k) => r[k]).join(' | ')} |`)].join('\n');
};
const toCsv = (rows) => {
  const keys = Object.keys(rows[0]);
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  return `﻿${[keys.map(esc).join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n')}\n`;
};

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, def) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : def);
const quick = flag('quick');
const nSeeds = Number(opt('seeds', quick ? 2 : 10));
const seeds = Array.from({ length: nSeeds }, (_, i) => i + 1);
const sizes = quick ? [10, 25, 50] : [10, 25, 50, 100, 150, 200];
const reps = quick ? () => 10 : (n) => (n <= 50 ? 30 : 5);
const scenarios = quick ? [['vừa', 40, 1]] : [['thưa đơn', 60, 0.5], ['vừa', 60, 1.5], ['cao điểm', 60, 3]];
const minutes = quick ? 60 : 120;
const acceptProb = Number(opt('accept', 0.85));
const ignoreProb = Number(opt('ignore', 0.1));

console.log('Phần A — Bài toán gán tĩnh: Greedy vs Hungarian');
const a = partA(sizes, reps, Number(opt('seed', 2026)));
const assumptions = `${nSeeds} hạt giống, ${minutes} phút/lần chạy; thợ không phản hồi ${ignoreProb * 100}% (offer hết hạn 60 s), phản hồi sau 3–25 s và nhận với xác suất ${acceptProb}; xe máy ${SPEED_KMH} km/h, sửa 30–90 phút; đơn chờ tối đa 15 phút`;
console.log(`\nPhần B — Mô phỏng vận hành (${assumptions})`);
const b = partB(scenarios, { minutes, acceptProb, ignoreProb, seeds });

const report = `## Phần A — Bài toán gán tĩnh\n\n${toMarkdown(a)}\n\n## Phần B — Mô phỏng vận hành (trung bình ± KTC 95%)\n\nGiả định: ${assumptions}.\n\n${toMarkdown(b)}\n`;
console.log(`\n${report}`);
const out = opt('out', null);
if (out) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'A_tinh.csv'), toCsv(a));
  fs.writeFileSync(path.join(out, 'B_dong.csv'), toCsv(b));
  fs.writeFileSync(path.join(out, 'ket_qua.md'), report);
  console.log(`Đã lưu kết quả vào ${path.resolve(out)}`);
}
