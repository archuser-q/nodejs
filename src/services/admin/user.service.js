import { query } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';

export const listUsers = async ({ role, search, status, page, pageSize }) => {
  const params = [role];
  const conditions = ['u.role = $1'];

  if (status) {
    params.push(status);
    conditions.push(`u.status = $${params.length}`);
  } else {
    conditions.push(`u.status <> 'deleted'`);
  }

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone ILIKE ${p})`);
  }

  params.push(pageSize, (page - 1) * pageSize);

  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.avatar_url, u.status, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = u.id)::int AS order_count,
            COUNT(*) OVER()::int AS total
     FROM users u
     WHERE ${conditions.join(' AND ')}
     ORDER BY u.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const total = rows[0]?.total ?? 0;
  return { items: rows.map(({ total, ...user }) => user), total };
};

export const updateUserStatus = async (id, status) => {
  const { rows } = await query(
    `UPDATE users SET status = $2, updated_at = NOW()
     WHERE id = $1 AND role <> 'admin' AND status <> 'deleted'
     RETURNING id, status`,
    [id, status],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy người dùng');
  return rows[0];
};

export const getUserDetail = async (id) => {
  const [user, stats, addresses, orders] = await Promise.all([
    query(
      `SELECT id, full_name, email, phone, avatar_url, role, status, phone_verified, created_at, last_login_at
       FROM users WHERE id = $1 AND role <> 'admin'`,
      [id],
    ),
    query(
      `SELECT COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_orders,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_orders,
              COALESCE(SUM(final_price) FILTER (WHERE status = 'completed'), 0)::float8 AS total_spent
       FROM orders WHERE customer_id = $1`,
      [id],
    ),
    query(
      `SELECT id, label, address_text, is_default
       FROM customer_addresses WHERE customer_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [id],
    ),
    query(
      `SELECT o.id, o.code, o.status, COALESCE(o.final_price, o.estimated_price)::float8 AS price, o.created_at,
              s.name AS service_name, w.full_name AS worker_name
       FROM orders o
       JOIN services s ON s.id = o.service_id
       LEFT JOIN users w ON w.id = o.worker_id
       WHERE o.customer_id = $1
       ORDER BY o.created_at DESC
       LIMIT 10`,
      [id],
    ),
  ]);

  if (!user.rows[0]) throw new AppError(404, 'Không tìm thấy người dùng');

  return {
    user: user.rows[0],
    stats: stats.rows[0],
    addresses: addresses.rows,
    recentOrders: orders.rows,
  };
};