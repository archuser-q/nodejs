import { query } from '../../config/db.js';

const TZ = 'Asia/Ho_Chi_Minh';

const RANGE = `(o.created_at AT TIME ZONE '${TZ}') >= $1::date
           AND (o.created_at AT TIME ZONE '${TZ}') < $2::date + 1`;

export const getReport = async ({ from, to, groupBy }) => {
  const range = [from, to];

  const [summary, timeline, categories, cancelReasons, topWorkers, matching] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE o.status = 'completed')::int AS completed_orders,
              COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled_orders,
              COALESCE(SUM(o.final_price) FILTER (WHERE o.status = 'completed'), 0)::float8 AS revenue,
              COALESCE(SUM(o.commission_amount) FILTER (WHERE o.status = 'completed'), 0)::float8 AS commission,
              COALESCE(AVG(o.final_price) FILTER (WHERE o.status = 'completed'), 0)::float8 AS avg_order_value
       FROM orders o WHERE ${RANGE}`,
      range,
    ),
    query(
      `WITH periods AS (
         SELECT generate_series(
           date_trunc($3, $1::date),
           date_trunc($3, $2::date),
           ('1 ' || $3)::interval
         )::date AS period
       ),
       o AS (
         SELECT date_trunc($3, o.created_at AT TIME ZONE '${TZ}')::date AS period, o.status, o.final_price
         FROM orders o WHERE ${RANGE}
       )
       SELECT to_char(p.period, 'YYYY-MM-DD') AS period,
              COUNT(o.status)::int AS total_orders,
              COUNT(o.status) FILTER (WHERE o.status = 'completed')::int AS completed_orders,
              COUNT(o.status) FILTER (WHERE o.status = 'cancelled')::int AS cancelled_orders,
              COALESCE(SUM(o.final_price) FILTER (WHERE o.status = 'completed'), 0)::float8 AS revenue
       FROM periods p
       LEFT JOIN o ON o.period = p.period
       GROUP BY p.period
       ORDER BY p.period`,
      [from, to, groupBy],
    ),
    query(
      `SELECT c.name AS category,
              COUNT(*)::int AS orders,
              COALESCE(SUM(o.final_price) FILTER (WHERE o.status = 'completed'), 0)::float8 AS revenue
       FROM orders o
       JOIN services s ON s.id = o.service_id
       JOIN service_categories c ON c.id = s.category_id
       WHERE ${RANGE}
       GROUP BY c.name
       ORDER BY orders DESC`,
      range,
    ),
    query(
      `SELECT COALESCE(NULLIF(TRIM(o.cancel_reason), ''), 'Không ghi lý do') AS reason, COUNT(*)::int AS count
       FROM orders o
       WHERE o.status = 'cancelled' AND ${RANGE}
       GROUP BY 1
       ORDER BY count DESC
       LIMIT 5`,
      range,
    ),
    query(
      `SELECT u.id, u.full_name,
              COUNT(*)::int AS jobs,
              COALESCE(SUM(o.final_price), 0)::float8 AS revenue,
              ROUND(AVG(r.rating), 2)::float8 AS avg_rating,
              w.trust_score::float8 AS trust_score
       FROM orders o
       JOIN users u ON u.id = o.worker_id
       JOIN workers w ON w.user_id = o.worker_id
       LEFT JOIN reviews r ON r.order_id = o.id
       WHERE o.status = 'completed' AND ${RANGE}
       GROUP BY u.id, u.full_name, w.trust_score
       ORDER BY revenue DESC
       LIMIT 10`,
      range,
    ),
    query(
      `SELECT o.matching_mode AS mode,
              COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE o.status = 'completed')::int AS completed_orders,
              COUNT(*) FILTER (WHERE o.status = 'cancelled' AND o.accepted_at IS NULL)::int AS unmatched_cancelled,
              ROUND(AVG(EXTRACT(EPOCH FROM o.accepted_at - o.created_at) / 60)::numeric, 1)::float8 AS avg_wait_minutes
       FROM orders o
       WHERE ${RANGE}
       GROUP BY o.matching_mode
       ORDER BY o.matching_mode`,
      range,
    ),
  ]);

  return {
    summary: summary.rows[0],
    timeline: timeline.rows,
    categories: categories.rows,
    cancelReasons: cancelReasons.rows,
    topWorkers: topWorkers.rows,
    matching: matching.rows,
  };
};