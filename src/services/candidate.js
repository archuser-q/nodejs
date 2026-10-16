import { query } from "../config/db.js";

export const findCandidates = async ({ lat, lng, categoryId, radiusKm, includeOffline = false }) => {
  const { rows } = await query(
    `WITH origin AS (
       SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS g
     )
     SELECT w.user_id AS id, u.full_name, u.phone, w.is_online,
            ST_Distance(w.current_location, origin.g)::float8 AS distance_m,
            w.trust_score::float8 AS trust_score,
            w.acceptance_rate::float8 AS acceptance_rate,
            COALESCE(ws.years, 0) AS skill_years,
            (SELECT COUNT(*) FROM orders o
             WHERE o.worker_id = w.user_id
               AND o.status <> 'cancelled'
               AND o.created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
            )::int AS jobs_today
     FROM workers w
     JOIN users u ON u.id = w.user_id
     JOIN worker_skills ws ON ws.worker_id = w.user_id AND ws.category_id = $3
     CROSS JOIN origin
     WHERE w.verification_status = 'approved'
       AND u.status = 'active'
       AND NOT w.is_busy
       AND ($5 OR w.is_online)
       AND w.current_location IS NOT NULL
       AND ST_DWithin(w.current_location, origin.g, $4 * 1000)`,
    [lat, lng, categoryId, radiusKm, includeOffline],
  );
  return rows;
};