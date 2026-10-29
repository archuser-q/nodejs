/**
 * Điểm tin cậy (Trust Score): lấy dữ liệu từ CSDL, tính bằng algorithms/trust.js, lưu kết quả.
 *
 * Gọi recalcTrustScore() ngay sau mỗi sự kiện làm thay đổi độ tin cậy của thợ (trong cùng transaction):
 *   - khách đánh giá đơn                 services/customer/interaction.service.js  createReview
 *   - thợ hoàn thành đơn                 services/worker/job.service.js            advanceStatus
 *   - thợ huỷ đơn đã nhận                services/worker/job.service.js            cancelJob
 *   - admin xử lý khiếu nại của khách    services/admin/complaint.service.js       handleComplaint
 * Mỗi lần điểm THAY ĐỔI ghi 1 dòng trust_score_history (điểm, điểm TB đơn giản, số đánh giá, lý do,
 * chi tiết thành phần) để admin / báo cáo xem lại vì sao điểm thay đổi.
 *
 * `npm run trust:recalc` tính lại cho mọi thợ (VD sau khi đổi tham số công thức).
 */
import { pool, sql } from '../../config/db.js';
import { TRUST_PARAMS, computeTrust, hasHistory, platformMean } from '../../algorithms/trust.js';

/** Số liệu đầu vào của công thức cho 1 thợ */
export async function trustInputs(db, workerId) {
  const { rows } = await sql(
    db,
    `SELECT
       (SELECT COUNT(*)::int FROM reviews WHERE worker_id = $1) AS review_count,
       (SELECT COALESCE(SUM(rating), 0)::int FROM reviews WHERE worker_id = $1) AS rating_sum,
       (SELECT COUNT(*)::int FROM orders
         WHERE worker_id = $1 AND status = 'completed'
           AND completed_at >= NOW() - make_interval(days => $2)) AS completed,
       -- huỷ sau khi đã nhận: lời mời của thợ chuyển 'accepted' -> 'cancelled' (job.service cancelJob)
       (SELECT COUNT(*)::int FROM order_offers
         WHERE worker_id = $1 AND status = 'cancelled'
           AND COALESCE(responded_at, offered_at) >= NOW() - make_interval(days => $2)) AS cancelled_after_accept,
       -- khiếu nại / bảo hành do KHÁCH gửi (reporter_id NULL) mà admin xác nhận đúng
       (SELECT COUNT(*)::int FROM complaints c JOIN orders o ON o.id = c.order_id
         WHERE o.worker_id = $1 AND c.reporter_id IS NULL AND c.status = 'resolved'
           AND c.created_at >= NOW() - make_interval(days => $2)) AS valid_complaints,
       (SELECT COUNT(*)::int FROM reviews) AS platform_count,
       (SELECT AVG(rating)::float8 FROM reviews) AS platform_avg`,
    [workerId, TRUST_PARAMS.windowDays],
  );
  const r = rows[0];
  return {
    reviewCount: r.review_count,
    ratingSum: r.rating_sum,
    completed: r.completed,
    cancelledAfterAccept: r.cancelled_after_accept,
    validComplaints: r.valid_complaints,
    mean: platformMean({ count: r.platform_count, avg: r.platform_avg }),
  };
}

/** Tính (không lưu) — dùng cho màn Hiệu suất của app thợ để giải thích điểm */
export async function explainTrust(db, workerId) {
  const inputs = await trustInputs(db, workerId);
  if (!hasHistory(inputs)) return { has_history: false, inputs, weights: TRUST_PARAMS.weights };
  const r = computeTrust(inputs);
  return { has_history: true, ...r, inputs, weights: TRUST_PARAMS.weights };
}

/**
 * Tính lại và lưu điểm tin cậy của 1 thợ. Thợ chưa có lịch sử thì bỏ qua (giữ 0 -> cold start khi ghép).
 * @param {string} reason lý do tính lại, ghi vào lịch sử (review | completed | worker_cancel | complaint | recalc)
 */
export async function recalcTrustScore(db, workerId, reason) {
  if (!workerId) return null;
  const inputs = await trustInputs(db, workerId);
  if (!hasHistory(inputs)) return null;
  const result = computeTrust(inputs);
  const { rows: cur } = await sql(db, 'SELECT trust_score FROM workers WHERE user_id = $1', [workerId]);
  if (Number(cur[0]?.trust_score) === result.score) return result; // không đổi (VD admin bác khiếu nại): không ghi lịch sử
  await sql(db, 'UPDATE workers SET trust_score = $2, updated_at = NOW() WHERE user_id = $1', [workerId, result.score]);
  const simpleAvg = inputs.reviewCount ? Math.round((inputs.ratingSum / inputs.reviewCount) * 100) / 100 : 0;
  await sql(
    db,
    `INSERT INTO trust_score_history (worker_id, trust_score, simple_avg, review_count, params)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      workerId,
      result.score,
      simpleAvg,
      inputs.reviewCount,
      { reason, components: result.components, bayes_rating: result.bayesRating, inputs, weights: TRUST_PARAMS.weights },
    ],
  );
  return result;
}

/** Tính lại cho mọi thợ đã có lịch sử (script trust:recalc, dữ liệu demo) */
export async function recalcAllTrustScores(db = pool, reason = 'recalc') {
  const { rows } = await sql(db, 'SELECT user_id FROM workers ORDER BY user_id');
  let updated = 0;
  for (const { user_id: id } of rows) {
    if (await recalcTrustScore(db, id, reason)) updated += 1;
  }
  return { workers: rows.length, updated };
}
