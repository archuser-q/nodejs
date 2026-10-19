/** Cấu hình ghép cặp đang áp dụng (bảng matching_configs do admin quản lý).  [Thành viên B] */
import { pool, sql } from '../../config/db.js';

export const MODES = ['instant', 'batch', 'auto'];

// Dùng khi admin chưa bật cấu hình nào (trọng số giống mặc định của web quản trị)
export const DEFAULT_CONFIG = {
  id: null,
  name: 'Mặc định (chưa có cấu hình)',
  w_distance: 0.35,
  w_trust: 0.3,
  w_skill: 0.15,
  w_acceptance: 0.1,
  w_workload: 0.1,
  max_radius_km: 10,
  offer_timeout_seconds: 30,
  batch_window_seconds: 10,
  mode: 'auto',
  max_offers: 1, // gửi lần lượt từng thợ: thực nghiệm cho thời gian thợ tới nơi và điểm phù hợp tốt nhất (docs/MATCHING.md)
};

/** id = null => cấu hình đang bật; không có thì DEFAULT_CONFIG */
export const getConfig = async (db = pool, id = null) => {
  const { rows } = await sql(
    db,
    `SELECT id, name, w_distance, w_trust, w_skill, w_acceptance, w_workload,
            max_radius_km, offer_timeout_seconds, batch_window_seconds, mode, max_offers
     FROM matching_configs WHERE ${id ? 'id = $1' : 'is_active'} LIMIT 1`,
    id ? [id] : [],
  );
  return rows[0] ?? DEFAULT_CONFIG;
};

/** Chế độ ghi vào orders.matching_mode / order_offers.mode: chỉ 'instant' | 'batch' (chế độ THỰC TẾ đã dùng) */
export const orderModeOf = (cfgMode) => (cfgMode === 'batch' ? 'batch' : 'instant');
