/**
 * Điểm tin cậy (Trust Score) của thợ — công thức thuần, không truy cập CSDL.
 * Dữ liệu đầu vào do services/trust/trust.service.js lấy từ CSDL; kết quả lưu ở workers.trust_score
 * (0..1) và là tiêu chí s_trust (trọng số mặc định 0,30) của hàm điểm ghép cặp (algorithms/scoring.js).
 *
 *   trust = 0,5 · s_rating + 0,3 · s_reliability + 0,2 · s_complaints        (∈ [0, 1])
 *
 * 1. s_rating — chất lượng theo đánh giá của khách, làm mượt kiểu Bayes (như cách IMDb xếp hạng phim):
 *        R = (C · m + Σ sao) / (C + n)          n: số đánh giá của thợ, C = 5 đánh giá "ảo"
 *        s_rating = (R − 1) / 4                 đổi thang 1..5 sao về 0..1
 *    m là điểm trung bình của cả nền tảng (đủ 20 đánh giá trở lên, chưa đủ thì lấy 4,0). Nhờ vậy
 *    thợ mới có đúng 1 đánh giá 5 sao không vọt lên đầu, và 1 đánh giá 1 sao không dìm hẳn thợ xuống;
 *    càng nhiều đánh giá, R càng tiến về điểm trung bình thật của thợ.
 *
 * 2. s_reliability — giữ lời: nhận đơn rồi có làm tới cùng không (180 ngày gần nhất):
 *        s_reliability = (K + 4,5) / (K + X + 5)
 *    K: số đơn đã hoàn thành, X: số lần huỷ sau khi đã nhận đơn. Phần "+4,5 / +5" là 5 đơn ảo với
 *    tỷ lệ hoàn thành 90%: thợ mới huỷ 1 lần không bị coi như "huỷ 100%".
 *
 * 3. s_complaints — khiếu nại của khách được admin xác nhận là đúng (180 ngày gần nhất):
 *        s_complaints = max(0, 1 − 4 · V / (K + 5))
 *    V: số khiếu nại / yêu cầu bảo hành do khách gửi mà admin đã xử lý "đúng" (resolved). Tính theo
 *    TỶ LỆ trên số đơn đã làm nên thợ làm nhiều đơn không bị thiệt so với thợ làm ít.
 *
 * Tỷ lệ nhận lời mời KHÔNG nằm ở đây vì đã là một tiêu chí riêng của hàm ghép (s_acceptance).
 * Thợ mới chưa có lịch sử nào thì không tính (trust_score = 0): khi ghép dùng mức trung tính 0,5
 * (cold start, xem services/matching/candidate.js).
 */

export const TRUST_PARAMS = Object.freeze({
  weights: { rating: 0.5, reliability: 0.3, complaints: 0.2 },
  priorReviews: 5, // C
  fallbackMean: 4.0, // m khi nền tảng chưa đủ đánh giá
  minReviewsForPlatformMean: 20,
  reliabilityPrior: { completed: 4.5, total: 5 },
  complaintFactor: 4,
  windowDays: 180,
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round4 = (v) => Math.round(v * 10000) / 10000;

/** Điểm trung bình dùng làm "điểm kỳ vọng" m cho làm mượt Bayes */
export function platformMean({ count, avg }, p = TRUST_PARAMS) {
  return count >= p.minReviewsForPlatformMean && Number.isFinite(avg) ? avg : p.fallbackMean;
}

/** Thợ đã có dữ liệu để tính chưa (chưa có -> giữ 0, ghép dùng cold start) */
export const hasHistory = ({ reviewCount = 0, completed = 0, cancelledAfterAccept = 0, validComplaints = 0 }) =>
  reviewCount + completed + cancelledAfterAccept + validComplaints > 0;

/**
 * @param {object} x
 * @param {number} x.reviewCount           n
 * @param {number} x.ratingSum             tổng số sao
 * @param {number} x.completed             K (180 ngày)
 * @param {number} x.cancelledAfterAccept  X (180 ngày)
 * @param {number} x.validComplaints       V (180 ngày)
 * @param {number} x.mean                  m (điểm trung bình nền tảng)
 * @returns {{ score: number, components: { rating: number, reliability: number, complaints: number }, bayesRating: number }}
 */
export function computeTrust(
  { reviewCount = 0, ratingSum = 0, completed = 0, cancelledAfterAccept = 0, validComplaints = 0, mean },
  p = TRUST_PARAMS,
) {
  const m = mean ?? p.fallbackMean;
  const bayesRating = (p.priorReviews * m + ratingSum) / (p.priorReviews + reviewCount);
  const rating = clamp01((bayesRating - 1) / 4);
  const reliability = clamp01(
    (completed + p.reliabilityPrior.completed) / (completed + cancelledAfterAccept + p.reliabilityPrior.total),
  );
  const complaints = clamp01(1 - (p.complaintFactor * validComplaints) / (completed + p.reliabilityPrior.total));
  const w = p.weights;
  const score = clamp01(w.rating * rating + w.reliability * reliability + w.complaints * complaints);
  return {
    score: round4(score),
    components: { rating: round4(rating), reliability: round4(reliability), complaints: round4(complaints) },
    bayesRating: Math.round(bayesRating * 100) / 100,
  };
}
