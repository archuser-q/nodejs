/**
 * Thuật toán Hungarian (Kuhn–Munkres) — tự cài đặt, không dùng thư viện ngoài.  [Thành viên B]
 *
 * Bài toán gán 2 phía có trọng số (weighted bipartite assignment):
 *   - n đơn đang chờ (hàng), m thợ đang rảnh (cột)
 *   - score[i][j] thuộc [0, 1] = điểm phù hợp đơn i – thợ j (cùng hàm điểm với chế độ tức thời),
 *     null = cặp không hợp lệ (thợ ngoài bán kính, không có kỹ năng, ...)
 *   - Tìm tập cặp (i, j), mỗi đơn tối đa 1 thợ, mỗi thợ tối đa 1 đơn, sao cho:
 *       (1) số cặp hợp lệ là LỚN NHẤT (ghép được càng nhiều đơn càng tốt), rồi
 *       (2) tổng điểm phù hợp là LỚN NHẤT trong các cách ghép đó.
 *
 * Quy về bài toán cực tiểu chi phí chuẩn:
 *   cost[i][j] = 1 - score[i][j]   nếu hợp lệ   (thuộc [0, 1])
 *   cost[i][j] = BIG = k + 1       nếu không hợp lệ, k = min(n, m)
 * Vì tổng chi phí mọi cặp hợp lệ <= k < BIG, lời giải tối ưu luôn dùng ít cặp "BIG" nhất có thể
 * (tức nhiều cặp hợp lệ nhất); với cùng số cặp hợp lệ thì min Σ(1 - s) <=> max Σ s.
 * Cặp "BIG" trong lời giải bị loại (đơn đó chờ lượt sau).
 *
 * Cài đặt: bản dùng thế vị (potentials) u, v + đường tăng ngắn nhất kiểu Dijkstra,
 * độ phức tạp O(n² · m) với n <= m (chuyển vị nếu n > m) — tức O(n³) khi n ≈ m.
 */

/**
 * Gán tối ưu cho ma trận chi phí n x m (n <= m), cực tiểu tổng chi phí.
 * Trả về assign[i] = cột được gán cho hàng i. Bên trong dùng chỉ số 1..n, 1..m; cột 0 là gốc giả.
 */
function minCostAssignment(cost) {
  const n = cost.length;
  const m = n ? cost[0].length : 0;
  if (n === 0) return [];
  if (n > m) throw new Error('Cần n <= m');

  const u = new Float64Array(n + 1); // thế vị hàng
  const v = new Float64Array(m + 1); // thế vị cột
  const p = new Int32Array(m + 1); // p[j] = hàng đang gán vào cột j (0 = trống)
  const way = new Int32Array(m + 1); // cột đứng trước j trên đường tăng

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      const row = cost[i0 - 1];
      const ui0 = u[i0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = row[j - 1] - ui0 - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // Lật đường tăng
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assign = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) assign[p[j] - 1] = j - 1;
  return assign;
}

/**
 * Ghép tối ưu toàn cục cho ma trận điểm n x m bất kỳ.
 * @param {(number|null)[][]} score
 * @returns {[number, number][]} các cặp [i, j] hợp lệ, sắp theo i
 */
export function hungarianMax(score) {
  const n = score.length;
  const m = n ? score[0].length : 0;
  if (n === 0 || m === 0) return [];

  const big = Math.min(n, m) + 1;
  let cost = score.map((row) => row.map((s) => (s === null || s === undefined ? big : 1 - s)));
  const transposed = n > m;
  if (transposed) cost = cost[0].map((_, j) => cost.map((row) => row[j]));

  const pairs = [];
  minCostAssignment(cost).forEach((c, r) => {
    if (c < 0) return;
    const [i, j] = transposed ? [c, r] : [r, c];
    if (score[i][j] !== null && score[i][j] !== undefined) pairs.push([i, j]);
  });
  return pairs.sort((a, b) => a[0] - b[0]);
}

export const totalScore = (score, pairs) => pairs.reduce((s, [i, j]) => s + score[i][j], 0);
