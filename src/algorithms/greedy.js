/**
 * Ghép tham lam (Greedy) theo thứ tự đến — mốc so sánh với Hungarian.  [Thành viên B]
 *
 * Chế độ tức thời xử lý từng đơn theo thứ tự đến: mỗi đơn lấy thợ có điểm cao nhất trong số thợ
 * còn rảnh lúc đó. Hàm này mô phỏng đúng cách làm đó trên một ma trận điểm
 * (thứ tự hàng = thứ tự đơn đến) để so sánh trực tiếp với lời giải tối ưu toàn cục.
 *
 * @param {(number|null)[][]} score
 * @returns {[number, number][]}
 */
export function greedyInOrder(score) {
  const taken = new Set();
  const pairs = [];
  score.forEach((row, i) => {
    let bestJ = -1;
    let best = -1;
    row.forEach((s, j) => {
      if (s !== null && s !== undefined && !taken.has(j) && s > best) {
        bestJ = j;
        best = s;
      }
    });
    if (bestJ >= 0) {
      taken.add(bestJ);
      pairs.push([i, bestJ]);
    }
  });
  return pairs;
}
