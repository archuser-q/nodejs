import { query } from '../config/db.js';
import { AppError } from '../utils/AppError.js';

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
  if (!rows[0]) throw new AppError(404, 'User not found');
  return rows[0];
};