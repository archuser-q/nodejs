/** Kiểm chứng thuật toán (không cần DB): Hungarian tự cài đặt so với vét cạn, Greedy, Union-Find, hàm điểm. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hungarianMax, totalScore } from '../src/algorithms/hungarian.js';
import { greedyInOrder } from '../src/algorithms/greedy.js';
import { competitionGroups } from '../src/algorithms/grouping.js';
import { rankForDispatch } from '../src/algorithms/scoring.js';
import { workerLevel } from '../src/services/worker/level.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* permutations(arr, k) {
  if (k === 0) return yield [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest, k - 1)) yield [arr[i], ...p];
  }
}

/** Vét cạn mọi cách gán; tiêu chí: (số cặp hợp lệ lớn nhất, rồi tổng điểm lớn nhất) */
function bruteForce(score) {
  const n = score.length;
  const m = score[0].length;
  let best = [-1, -1];
  const consider = (pairs) => {
    const key = [pairs.length, Math.round(totalScore(score, pairs) * 1e9) / 1e9];
    if (key[0] > best[0] || (key[0] === best[0] && key[1] > best[1])) best = key;
  };
  if (n <= m) {
    for (const perm of permutations([...Array(m).keys()], n)) consider(perm.map((j, i) => [i, j]).filter(([i, j]) => score[i][j] !== null));
  } else {
    for (const perm of permutations([...Array(n).keys()], m)) consider(perm.map((i, j) => [i, j]).filter(([i, j]) => score[i][j] !== null));
  }
  return best;
}

const randomMatrix = (r, n, m, pInvalid) =>
  Array.from({ length: n }, () => Array.from({ length: m }, () => (r() < pInvalid ? null : Math.round(r() * 1e4) / 1e4)));

test('Hungarian khớp vét cạn trên 300 ma trận ngẫu nhiên (kể cả ô không hợp lệ, n ≠ m)', () => {
  for (let seed = 0; seed < 300; seed++) {
    const r = rng(seed);
    const n = 1 + Math.floor(r() * 6);
    const m = 1 + Math.floor(r() * 6);
    const score = randomMatrix(r, n, m, [0, 0.2, 0.5, 0.8][Math.floor(r() * 4)]);
    const pairs = hungarianMax(score);
    assert.equal(new Set(pairs.map((p) => p[0])).size, pairs.length);
    assert.equal(new Set(pairs.map((p) => p[1])).size, pairs.length);
    assert.ok(pairs.every(([i, j]) => score[i][j] !== null));
    const got = [pairs.length, Math.round(totalScore(score, pairs) * 1e9) / 1e9];
    assert.deepEqual(got, bruteForce(score), `seed ${seed}`);
  }
});

test('ví dụ kinh điển: Hungarian thắng Greedy theo thứ tự đến', () => {
  // Đơn A đến trước "chiếm" thợ 0 (0.9) khiến đơn B chỉ còn thợ 1 (0.1).
  // Tối ưu toàn cục: A-1 (0.8) + B-0 (0.85) = 1.65 > greedy 0.9 + 0.1 = 1.0
  const score = [[0.9, 0.8], [0.85, 0.1]];
  assert.equal(totalScore(score, greedyInOrder(score)), 1.0);
  assert.deepEqual(hungarianMax(score), [[0, 1], [1, 0]]);
  assert.ok(Math.abs(totalScore(score, hungarianMax(score)) - 1.65) < 1e-9);
});

test('ưu tiên ghép được nhiều đơn hơn là tổng điểm cao hơn', () => {
  assert.deepEqual(hungarianMax([[1.0, 0.1], [0.1, null]]), [[0, 1], [1, 0]]);
});

test('ma trận rỗng / toàn ô không hợp lệ', () => {
  assert.deepEqual(hungarianMax([]), []);
  assert.deepEqual(hungarianMax([[null, null], [null, null]]), []);
});

test('Hungarian không bao giờ kém Greedy trên ma trận lớn', () => {
  const r = rng(7);
  for (let k = 0; k < 30; k++) {
    const score = randomMatrix(r, 5 + Math.floor(r() * 36), 5 + Math.floor(r() * 36), 0.3);
    const h = hungarianMax(score);
    const g = greedyInOrder(score);
    assert.ok(h.length > g.length || (h.length === g.length && totalScore(score, h) >= totalScore(score, g) - 1e-9));
  }
});

test('nhóm tranh chấp (Union-Find) nối bắc cầu', () => {
  // đơn 0-1 chung thợ 10, đơn 1-2 chung thợ 11 -> 1 nhóm; đơn 3 riêng; đơn 4 không có ứng viên
  const groups = competitionGroups([[10], [10, 11], [11, 12], [20], []]);
  assert.deepEqual(groups.map((g) => g.sort()).sort((a, b) => a[0] - b[0]), [[0, 1, 2], [3], [4]]);
});

test('hàm điểm: 5 tiêu chí đúng công thức, xếp hạng ổn định (hoà điểm thì gần hơn trước)', () => {
  const cfg = { w_distance: 0.35, w_trust: 0.3, w_skill: 0.15, w_acceptance: 0.1, w_workload: 0.1, max_radius_km: 10 };
  const c = { id: 1, distance_m: 2000, trust_score: 0.9, skill_years: 5, acceptance_rate: 0.8, jobs_today: 1 };
  const [s] = rankForDispatch([c], cfg);
  const expect = 0.35 * 0.8 + 0.3 * 0.9 + 0.15 * 0.5 + 0.1 * 0.8 + 0.1 * 0.8;
  assert.ok(Math.abs(s.score - expect) < 1e-12);
  const tie = rankForDispatch(
    [
      { ...c, id: 3, distance_m: 2000 },
      { ...c, id: 2, distance_m: 2000 },
      { ...c, id: 9, distance_m: 2000, trust_score: 0.9 + 1e-9 },
    ],
    { ...cfg, w_distance: 0, w_trust: 1, w_skill: 0, w_acceptance: 0, w_workload: 0 },
  );
  assert.deepEqual(tie.map((x) => x.id), [9, 2, 3]);
  // ngoài bán kính / số năm vượt trần / quá tải đều bị chặn về [0, 1]
  const [far] = rankForDispatch([{ ...c, distance_m: 50_000, skill_years: 40, jobs_today: 12 }], cfg);
  assert.deepEqual(far.criteria, { distance: 0, trust: 0.9, skill: 1, acceptance: 0.8, workload: 0 });
});

test('hạng thợ theo mốc số đơn + điểm đánh giá', () => {
  assert.equal(workerLevel(0, null).key, 'dong');
  assert.equal(workerLevel(30, 4.6).key, 'bac');
  assert.equal(workerLevel(120, 4.6).key, 'bac'); // đủ đơn nhưng điểm chưa tới mốc Vàng
  assert.equal(workerLevel(120, 4.8).key, 'vang');
  assert.equal(workerLevel(400, 4.9).key, 'kim_cuong');
  assert.equal(workerLevel(65, 4.9).progress, 0.5);
});

test('điểm tin cậy: làm mượt Bayes, giữ lời, khiếu nại theo tỷ lệ', async () => {
  const { computeTrust, hasHistory, platformMean, TRUST_PARAMS } = await import('../src/algorithms/trust.js');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} ≉ ${b}`);
  // chưa có gì: không tính (ghép dùng cold start 0,5)
  assert.equal(hasHistory({}), false);
  assert.equal(hasHistory({ completed: 1 }), true);
  // trung bình nền tảng: chưa đủ 20 đánh giá thì dùng 4,0
  assert.equal(platformMean({ count: 5, avg: 4.9 }), 4.0);
  assert.equal(platformMean({ count: 50, avg: 4.6 }), 4.6);

  // 1 đơn hoàn thành, 1 đánh giá 5 sao: R = (5·4 + 5)/6 = 4,1667 -> 0,7917; giữ lời (1+4,5)/(1+5) = 0,9167; khiếu nại 1
  const one = computeTrust({ reviewCount: 1, ratingSum: 5, completed: 1, mean: 4 });
  near(one.components.rating, 0.7917);
  near(one.components.reliability, 0.9167);
  near(one.components.complaints, 1);
  near(one.score, 0.5 * 0.7917 + 0.3 * 0.9167 + 0.2);
  // 1 đánh giá 5 sao không vọt lên tối đa; 100 đánh giá 5 sao thì gần tối đa
  const many = computeTrust({ reviewCount: 100, ratingSum: 500, completed: 100, mean: 4 });
  assert.ok(one.components.rating < 0.8 && many.components.rating > 0.98);
  // 1 đánh giá 1 sao không dìm hẳn thợ mới: R = (20 + 1)/6 = 3,5 -> 0,625
  near(computeTrust({ reviewCount: 1, ratingSum: 1, completed: 1, mean: 4 }).components.rating, 0.625);
  // huỷ sau khi nhận làm giảm điểm; khiếu nại tính theo tỷ lệ trên số đơn đã làm
  const cancel = computeTrust({ completed: 1, cancelledAfterAccept: 3, mean: 4 });
  assert.ok(cancel.components.reliability < 0.62);
  const fewJobs = computeTrust({ completed: 3, validComplaints: 1, mean: 4 }).components.complaints; // 1 − 4/8
  const manyJobs = computeTrust({ completed: 95, validComplaints: 1, mean: 4 }).components.complaints; // 1 − 4/100
  near(fewJobs, 0.5);
  near(manyJobs, 0.96);
  // điểm luôn trong [0, 1], trọng số cộng lại = 1
  const w = TRUST_PARAMS.weights;
  near(w.rating + w.reliability + w.complaints, 1);
  const worst = computeTrust({ reviewCount: 200, ratingSum: 200, completed: 0, cancelledAfterAccept: 50, validComplaints: 10, mean: 4 });
  assert.ok(worst.score >= 0 && worst.score < 0.2);
});
