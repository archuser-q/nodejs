import { query } from '../config/db.js';

export const getOverview = async () => {
  const statsQuery = query(`
    SELECT
      (SELECT COALESCE(SUM(final_price), 0) FROM orders
         WHERE status = 'completed' AND completed_at >= date_trunc('month', NOW()))::float8 AS revenue_month,
      (SELECT COUNT(*) FROM orders WHERE created_at >= date_trunc('day', NOW()))::int AS orders_today,
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