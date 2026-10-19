/**
 * Cập nhật tỷ lệ nhận đơn / tỷ lệ huỷ của thợ — đầu vào tiêu chí s_acceptance của hàm điểm.  [Thành viên B]
 *
 *   acceptance_rate = (nhận + PRIOR) / (nhận + bỏ lỡ + PRIOR)     trong 30 ngày gần nhất
 *     nhận   = offer accepted hoặc cancelled (đã nhận rồi mới huỷ)
 *     bỏ lỡ  = rejected, hoặc expired vì hết giờ mà thợ không trả lời
 *     KHÔNG tính offer bị đóng sớm vì đơn đã có thợ khác nhận / khách huỷ / thợ tắt nhận đơn
 *     (reason = 'closed' | 'offline', hoặc bị đóng trước giờ hết hạn)
 *     PRIOR  = 3 lần nhận "ảo" (làm mượt kiểu Bayes): thợ mới không bị tụt điểm mạnh chỉ vì 1 lần bỏ lỡ
 *   cancel_rate = huỷ sau khi nhận / số lần nhận
 */
import { sql } from '../../config/db.js';

const PRIOR = 3;
const WINDOW_DAYS = 30;

export const refreshWorkerStats = async (db, workerIds) => {
  const ids = [...new Set(workerIds.map(Number).filter(Boolean))];
  if (!ids.length) return;
  await sql(
    db,
    `WITH s AS (
       SELECT w.user_id,
              COUNT(o.id) FILTER (WHERE o.status IN ('accepted', 'cancelled')) AS took,
              COUNT(o.id) FILTER (WHERE o.status = 'rejected'
                                   OR (o.status = 'expired' AND o.reason IS NULL
                                       AND o.responded_at >= o.expires_at)) AS missed,
              COUNT(o.id) FILTER (WHERE o.status = 'cancelled') AS cancelled
       FROM workers w
       LEFT JOIN order_offers o ON o.worker_id = w.user_id
                               AND o.offered_at >= NOW() - make_interval(days => $2)
       WHERE w.user_id = ANY($1::bigint[])
       GROUP BY w.user_id
     )
     UPDATE workers w SET
       acceptance_rate = ROUND((s.took + $3)::numeric / (s.took + s.missed + $3), 4),
       cancel_rate = CASE WHEN s.took = 0 THEN 0 ELSE ROUND(s.cancelled::numeric / s.took, 4) END,
       updated_at = NOW()
     FROM s WHERE w.user_id = s.user_id`,
    [ids, WINDOW_DAYS, PRIOR],
  );
};
