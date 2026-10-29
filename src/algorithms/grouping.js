/**
 * Chia các đơn đang chờ thành NHÓM TRANH CHẤP thợ — nền tảng của chế độ "auto".  [Thành viên B]
 *
 * Hai đơn cùng nhóm nếu có chung ít nhất 1 thợ ứng viên, nối bắc cầu
 * (A chung thợ với B, B chung thợ với C => A, B, C cùng nhóm).
 * Cài đặt bằng Union-Find (DSU) có nén đường đi, ~O(tổng số cặp đơn–ứng viên).
 *
 * Ý nghĩa cho bộ điều phối:
 *  - Nhóm 1 đơn: không đơn nào khác cần thợ của nó => Hungarian trên 1 hàng chính là chọn thợ điểm
 *    cao nhất, nên dùng Greedy top-k (gửi ngay, có dự phòng k thợ) là tối ưu cho đơn đó.
 *  - Nhóm >= 2 đơn: các đơn giành nhau thợ => Hungarian trên nhóm để tối đa tổng điểm toàn cục.
 *  - Các nhóm không chung thợ nên giải riêng từng nhóm cho cùng kết quả với giải chung, mà ma trận nhỏ hơn.
 *
 * @param {Iterable<number|string>[]} candidates candidates[i] = tập id thợ ứng viên của đơn i
 * @returns {number[][]} các nhóm (chỉ số đơn tăng dần)
 */
export function competitionGroups(candidates) {
  const parent = candidates.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  const owner = new Map(); // id thợ -> đơn đầu tiên có thợ đó
  candidates.forEach((cand, i) => {
    for (const wid of cand) {
      const key = String(wid);
      if (owner.has(key)) {
        const ra = find(i);
        const rb = find(owner.get(key));
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      } else {
        owner.set(key, i);
      }
    }
  });

  const groups = new Map();
  candidates.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return [...groups.values()];
}
