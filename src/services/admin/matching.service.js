import { pool, query } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { findCandidates } from '../matching/candidate.js';
import { rankCandidates } from '../../algorithms/scoring.js';

const FIELDS = [
  'name', 'w_distance', 'w_trust', 'w_skill', 'w_acceptance', 'w_workload',
  'max_radius_km', 'offer_timeout_seconds', 'batch_window_seconds',
];

const SELECT = `
  SELECT m.id, m.name,
         m.w_distance::float8 AS w_distance, m.w_trust::float8 AS w_trust, m.w_skill::float8 AS w_skill,
         m.w_acceptance::float8 AS w_acceptance, m.w_workload::float8 AS w_workload,
         m.max_radius_km::float8 AS max_radius_km, m.offer_timeout_seconds, m.batch_window_seconds,
         m.mode, m.max_offers,
         m.is_active, m.created_at, m.updated_at, u.full_name AS updated_by_name,
         (SELECT COUNT(*) FROM orders o WHERE o.matching_config_id = m.id)::int AS order_count
  FROM matching_configs m
  LEFT JOIN users u ON u.id = m.updated_by`;

const getUsage = async (client, id) => {
  const { rows } = await client.query(
    `SELECT is_active, (SELECT COUNT(*) FROM orders WHERE matching_config_id = $1)::int AS order_count
     FROM matching_configs WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy cấu hình');
  return rows[0];
};

export const listConfigs = async () => {
  const { rows } = await query(`${SELECT} ORDER BY m.is_active DESC, m.created_at DESC`);
  return rows;
};

// [B] Cột tuỳ chọn: chế độ ghép + k (không gửi thì giữ giá trị cũ / mặc định của bảng)
const OPTIONAL = ['mode', 'max_offers'];

export const createConfig = async (data, adminId) => {
  const { rows } = await query(
    `INSERT INTO matching_configs (${FIELDS.join(', ')}, updated_by)
     VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')}, $${FIELDS.length + 1})
     RETURNING id`,
    [...FIELDS.map((f) => data[f]), adminId],
  );
  await setOptional(rows[0].id, data);
  return rows[0];
};

const setOptional = async (id, data) => {
  const keys = OPTIONAL.filter((k) => data[k] !== undefined);
  if (!keys.length) return;
  await query(
    `UPDATE matching_configs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...keys.map((k) => data[k])],
  );
};

export const updateConfig = async (id, data, adminId) => {
  const usage = await getUsage(pool, id);
  if (usage.order_count > 0) {
    throw new AppError(400, 'Cấu hình đã được đơn hàng sử dụng. Hãy nhân bản để chỉnh sửa.');
  }

  await query(
    `UPDATE matching_configs
     SET ${FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')},
         updated_by = $${FIELDS.length + 2}, updated_at = NOW()
     WHERE id = $1`,
    [id, ...FIELDS.map((f) => data[f]), adminId],
  );
  await setOptional(id, data);
};

export const activateConfig = async (id, adminId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getUsage(client, id);
    await client.query('UPDATE matching_configs SET is_active = FALSE WHERE is_active');
    await client.query(
      'UPDATE matching_configs SET is_active = TRUE, updated_by = $2, updated_at = NOW() WHERE id = $1',
      [id, adminId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const deleteConfig = async (id) => {
  const usage = await getUsage(pool, id);
  if (usage.is_active) throw new AppError(400, 'Không xoá được cấu hình đang áp dụng');
  if (usage.order_count > 0) throw new AppError(400, 'Không xoá được cấu hình đã được đơn hàng sử dụng');
  await query('DELETE FROM matching_configs WHERE id = $1', [id]);
};

export const simulate = async ({ config, lat, lng, categoryId, includeOffline, limit }) => {
  const started = performance.now();
  const candidates = await findCandidates({
    lat, lng, categoryId, radiusKm: config.max_radius_km, includeOffline,
  });
  const queryMs = Math.round((performance.now() - started) * 10) / 10;

  const ranked = rankCandidates(candidates, config);
  return { total: ranked.length, query_ms: queryMs, items: ranked.slice(0, limit) };
};