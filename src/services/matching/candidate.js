import { pool, sql } from "../../config/db.js";
import { settings } from "../../config/settings.js";

/**
 * Tìm thợ ứng viên quanh 1 điểm bằng chỉ mục không gian (GiST trên workers.current_location).
 * Dùng chung cho trang "Mô phỏng" của admin và bộ điều phối ghép cặp.
 *
 * [B] Thêm 2 tuỳ chọn, mặc định giữ nguyên hành vi cũ:
 *   - includeBusy: đơn hẹn trước thì thợ đang bận việc khác vẫn có thể nhận lịch sau
 *   - db: chạy trong transaction của bộ điều phối (mặc định pool)
 *   và trả thêm service_radius_km, location_updated_at để lọc ràng buộc cứng.
 * [B] Cold start: thợ chưa có đơn hoàn thành, chưa có đánh giá và trust_score chưa được tính (= 0)
 *   thì dùng mức trung tính settings.trustColdStart (mặc định 0.5) khi chấm điểm, cột trust_cold_start = true.
 */
export const findCandidates = async ({
  lat, lng, categoryId, radiusKm, includeOffline = false, includeBusy = false, db = pool,
}) => {
  const { rows } = await sql(
    db,
    `WITH origin AS (
       SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS g
     )
     SELECT w.user_id AS id, u.full_name, u.phone, w.is_online, w.is_busy,
            ST_Distance(w.current_location, origin.g)::float8 AS distance_m,
            CASE WHEN w.total_jobs = 0 AND w.rating_count = 0 AND w.trust_score = 0
                 THEN $7::float8 ELSE w.trust_score::float8 END AS trust_score,
            (w.total_jobs = 0 AND w.rating_count = 0 AND w.trust_score = 0) AS trust_cold_start,
            w.acceptance_rate::float8 AS acceptance_rate,
            COALESCE(ws.years, 0) AS skill_years,
            (SELECT COUNT(*) FROM orders o
             WHERE o.worker_id = w.user_id
               AND o.status <> 'cancelled'
               AND o.created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
            )::int AS jobs_today,
            w.service_radius_km::float8 AS service_radius_km,
            w.location_updated_at
     FROM workers w
     JOIN users u ON u.id = w.user_id
     JOIN worker_skills ws ON ws.worker_id = w.user_id AND ws.category_id = $3
     CROSS JOIN origin
     WHERE w.verification_status = 'approved'
       AND u.status = 'active'
       AND ($6 OR NOT w.is_busy)
       AND ($5 OR w.is_online)
       AND w.current_location IS NOT NULL
       AND ST_DWithin(w.current_location, origin.g, $4 * 1000)`,
    [lat, lng, categoryId, radiusKm, includeOffline, includeBusy, settings.trustColdStart],
  );
  return rows;
};
