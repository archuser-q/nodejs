import { query } from '../config/db.js';
import { AppError } from '../utils/AppError.js';

// source: 'customer' = khách gửi (reporter_id NULL), 'worker' = thợ báo cáo sự cố từ app thợ (reporter_id = id thợ)
// workerId: chỉ lấy sự cố liên quan 1 thợ = báo cáo thợ đó gửi + khiếu nại của khách về đơn thợ đó làm
export const listComplaints = async ({ search, status, type, source, workerId, page, pageSize }) => {
  const params = [];
  const conditions = ['TRUE'];

  if (status) {
    params.push(status);
    conditions.push(`cp.status = $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`cp.type = $${params.length}`);
  }
  if (source === 'worker') conditions.push('cp.reporter_id IS NOT NULL');
  if (workerId) {
    params.push(workerId);
    const p = `$${params.length}`;
    conditions.push(`(cp.reporter_id = ${p} OR (o.worker_id = ${p} AND cp.reporter_id IS NULL))`);
  }
  if (source === 'customer') conditions.push('cp.reporter_id IS NULL');
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(cp.title ILIKE ${p} OR o.code ILIKE ${p} OR c.full_name ILIKE ${p} OR w.full_name ILIKE ${p})`);
  }

  params.push(pageSize, (page - 1) * pageSize);

  const { rows } = await query(
    `SELECT cp.id, cp.type, cp.title, cp.status, cp.created_at, cp.resolved_at,
            cp.reporter_id, CASE WHEN cp.reporter_id IS NULL THEN 'customer' ELSE 'worker' END AS source,
            o.id AS order_id, o.code AS order_code,
            c.full_name AS customer_name, w.full_name AS worker_name,
            COUNT(*) OVER()::int AS total
     FROM complaints cp
     JOIN orders o ON o.id = cp.order_id
     JOIN users c ON c.id = cp.customer_id
     LEFT JOIN users w ON w.id = o.worker_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY (cp.status IN ('open', 'processing')) DESC, cp.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const total = rows[0]?.total ?? 0;
  return { items: rows.map(({ total, ...item }) => item), total };
};

export const getComplaintDetail = async (id) => {
  const { rows } = await query(
    `SELECT cp.id, cp.type, cp.title, cp.content, cp.image_urls, cp.status, cp.resolution,
            cp.created_at, cp.resolved_at,
            cp.reporter_id, CASE WHEN cp.reporter_id IS NULL THEN 'customer' ELSE 'worker' END AS source,
            rp.full_name AS reporter_name,
            o.id AS order_id, o.code AS order_code, o.status AS order_status,
            o.final_price::float8 AS order_price, o.completed_at AS order_completed_at,
            o.warranty_until, s.name AS service_name,
            c.id AS customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
            w.id AS worker_id, w.full_name AS worker_name, w.phone AS worker_phone,
            h.full_name AS handled_by_name
     FROM complaints cp
     JOIN orders o ON o.id = cp.order_id
     JOIN services s ON s.id = o.service_id
     JOIN users c ON c.id = cp.customer_id
     LEFT JOIN users w ON w.id = o.worker_id
     LEFT JOIN users h ON h.id = cp.handled_by
     LEFT JOIN users rp ON rp.id = cp.reporter_id
     WHERE cp.id = $1`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy khiếu nại');
  return rows[0];
};

export const handleComplaint = async (id, adminId, status, resolution) => {
  const closing = ['resolved', 'rejected'].includes(status);
  const { rows } = await query(
    `UPDATE complaints
     SET status = $2,
         resolution = COALESCE($3, resolution),
         handled_by = $4,
         resolved_at = CASE WHEN $5 THEN NOW() ELSE NULL END
     WHERE id = $1 AND status IN ('open', 'processing')
     RETURNING id, status, title, resolution, order_id, customer_id, reporter_id`,
    [id, status, resolution, adminId, closing],
  );

  if (!rows[0]) {
    const { rows: exists } = await query('SELECT status FROM complaints WHERE id = $1', [id]);
    if (!exists[0]) throw new AppError(404, 'Không tìm thấy khiếu nại');
    throw new AppError(400, 'Khiếu nại này đã đóng');
  }
  return rows[0];
};