import { query } from '../config/db.js';

// Đơn còn đang chạy (chưa hoàn thành / huỷ) để vẽ lên bản đồ tổng
const ACTIVE_STATUSES = ['pending', 'matching', 'accepted', 'on_the_way', 'arrived', 'in_progress'];

/**
 * Dữ liệu bản đồ giám sát của web quản trị (web gọi lại mỗi vài giây).
 *  - orders: đơn đang chạy, kèm thợ phụ trách và tình trạng hàng đợi ghép cặp
 *  - workers: thợ đã duyệt có vị trí (đang bật nhận đơn, đang làm đơn, hoặc vừa cập nhật vị trí trong 2 giờ)
 * Vị trí thợ do app thợ gửi qua PATCH /api/worker/location.
 */
export const getMapData = async ({ locationMaxAgeMinutes = 10 } = {}) => {
  const [orders, workers] = await Promise.all([
    query(
      `SELECT o.id, o.code, o.status, o.address_text, o.scheduled_at, o.created_at, o.accepted_at,
              COALESCE(o.final_price, o.estimated_price)::float8 AS price,
              ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng,
              s.name AS service_name, cat.name AS category_name,
              c.full_name AS customer_name, o.worker_id, w.full_name AS worker_name,
              d.rounds AS dispatch_rounds, d.offers_sent AS dispatch_offers, d.last_candidates AS dispatch_candidates,
              (SELECT COUNT(*) FROM order_offers f
                 WHERE f.order_id = o.id AND f.status = 'offered' AND f.expires_at > NOW())::int AS live_offers
       FROM orders o
       JOIN services s ON s.id = o.service_id
       JOIN service_categories cat ON cat.id = s.category_id
       JOIN users c ON c.id = o.customer_id
       LEFT JOIN users w ON w.id = o.worker_id
       LEFT JOIN order_dispatches d ON d.order_id = o.id
       WHERE o.status = ANY($1::order_status[])
       ORDER BY o.created_at DESC
       LIMIT 500`,
      [ACTIVE_STATUSES],
    ),
    query(
      `SELECT u.id, u.full_name, u.phone, u.avatar_url, w.is_online, w.is_busy,
              ST_Y(w.current_location::geometry) AS lat, ST_X(w.current_location::geometry) AS lng,
              w.location_updated_at, w.service_radius_km::float8 AS service_radius_km,
              w.rating_avg::float8 AS rating_avg, w.rating_count,
              (w.location_updated_at > NOW() - make_interval(mins => $1::int)) AS location_fresh,
              (SELECT o.code FROM orders o
                 WHERE o.worker_id = u.id AND o.status IN ('accepted', 'on_the_way', 'arrived', 'in_progress')
                 ORDER BY o.accepted_at DESC NULLS LAST LIMIT 1) AS current_order_code,
              COALESCE((SELECT array_agg(c.name ORDER BY c.sort_order, c.name)
                        FROM worker_skills ws JOIN service_categories c ON c.id = ws.category_id
                        WHERE ws.worker_id = u.id), '{}') AS skills
       FROM workers w
       JOIN users u ON u.id = w.user_id
       WHERE u.role = 'worker' AND u.status = 'active' AND w.verification_status = 'approved'
         AND w.current_location IS NOT NULL
         AND (w.is_online OR w.is_busy OR w.location_updated_at > NOW() - INTERVAL '2 hours')
       ORDER BY w.location_updated_at DESC NULLS LAST
       LIMIT 2000`,
      [locationMaxAgeMinutes || 10],
    ),
  ]);

  return { orders: orders.rows, workers: workers.rows, generated_at: new Date().toISOString() };
};
