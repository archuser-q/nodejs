import { query } from '../config/db.js';

export const getOverview = async () => {
  const statsQuery = query(`
    SELECT
      (SELECT COALESCE(SUM(final_price), 0) FROM orders
         WHERE status = 'completed'
           AND completed_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')::float8 AS revenue_month,
      (SELECT COUNT(*) FROM orders
         WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS orders_today,
      (SELECT COUNT(*) FROM workers WHERE is_online AND verification_status = 'approved')::int AS workers_online,
      (SELECT COUNT(*) FROM complaints WHERE status IN ('open', 'processing'))::int AS open_complaints
  `);

  const recentQuery = query(`
    SELECT o.id, o.code, o.status, COALESCE(o.final_price, o.estimated_price)::float8 AS price, o.created_at,
           c.full_name AS customer_name, s.name AS service_name, w.full_name AS worker_name
    FROM orders o
    JOIN users c ON c.id = o.customer_id
    JOIN services s ON s.id = o.service_id
    LEFT JOIN users w ON w.id = o.worker_id
    ORDER BY o.created_at DESC
    LIMIT 5
  `);

  const [stats, recent] = await Promise.all([statsQuery, recentQuery]);
  return { stats: stats.rows[0], recentOrders: recent.rows };
};

/**
 * Việc admin cần xử lý (chuông thông báo trên header + ô cảnh báo ở trang tổng quan).
 * workers_to_review: hồ sơ đã gửi đang chờ duyệt + thợ đã duyệt gửi giấy tờ mới.
 */
export const getPending = async () => {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*) FROM workers w JOIN users u ON u.id = w.user_id
         WHERE u.status <> 'deleted' AND (
           (w.verification_status = 'pending' AND w.submitted_at IS NOT NULL)
           OR (w.verification_status = 'approved' AND EXISTS (
                 SELECT 1 FROM worker_documents d WHERE d.worker_id = w.user_id AND d.status = 'pending'))))::int AS workers_to_review,
      (SELECT COUNT(*) FROM worker_withdrawals WHERE status = 'pending')::int AS withdrawals_pending,
      (SELECT COALESCE(SUM(amount), 0) FROM worker_withdrawals WHERE status = 'pending')::float8 AS withdrawals_pending_amount,
      (SELECT COUNT(*) FROM complaints WHERE status IN ('open', 'processing') AND reporter_id IS NULL)::int AS complaints_open,
      (SELECT COUNT(*) FROM complaints WHERE status IN ('open', 'processing') AND reporter_id IS NOT NULL)::int AS reports_open,
      (SELECT COUNT(*) FROM orders WHERE status = 'matching')::int AS orders_matching,
      (SELECT COUNT(*) FROM orders o WHERE o.status = 'matching' AND o.scheduled_at IS NULL
         AND o.created_at < NOW() - INTERVAL '5 minutes')::int AS orders_waiting_long
  `);
  return rows[0];
};
