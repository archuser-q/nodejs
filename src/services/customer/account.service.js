import bcrypt from 'bcrypt';
import { q as query, sql } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { signToken } from '../../utils/jwt.js';
import { USER_FIELDS } from '../../middlewares/requireCustomer.js';
import { withTransaction } from './common.js';

const issueToken = (user) => signToken({ sub: String(user.id), role: user.role }, env.mobileJwtExpiresIn);

// ── Đăng ký / đăng nhập ─────────────────────────────────────────────────────

export const register = async ({ fullName, phone, email, password }) => {
  const { rows: dup } = await query(
    'SELECT phone, email FROM users WHERE phone = $1 OR ($2::text IS NOT NULL AND email = $2)',
    [phone, email],
  );
  if (dup.some((u) => u.phone === phone)) throw new AppError(409, 'Số điện thoại đã được đăng ký');
  if (dup.length) throw new AppError(409, 'Email đã được sử dụng');

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (phone, email, password_hash, full_name, role, last_login_at)
     VALUES ($1, $2, $3, $4, 'customer', NOW())
     RETURNING ${USER_FIELDS}`,
    [phone, email, hash, fullName],
  );
  return { token: issueToken(rows[0]), user: rows[0] };
};

export const login = async (identifier, password) => {
  const { rows } = await query(
    `SELECT ${USER_FIELDS}, password_hash FROM users WHERE phone = $1 OR email = $1 LIMIT 1`,
    [identifier],
  );
  const user = rows[0];
  const ok = user?.password_hash && (await bcrypt.compare(password, user.password_hash));
  if (!ok) throw new AppError(401, 'Số điện thoại hoặc mật khẩu không đúng');
  if (user.role !== 'customer') throw new AppError(403, 'Tài khoản này không phải tài khoản khách hàng');
  if (user.status !== 'active') throw new AppError(403, 'Tài khoản đã bị khoá');

  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
  const { password_hash, ...safeUser } = user;
  return { token: issueToken(safeUser), user: safeUser };
};

export const updateProfile = async (userId, { fullName, email }) => {
  if (email) {
    const { rows } = await query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [email, userId]);
    if (rows.length) throw new AppError(409, 'Email đã được sử dụng');
  }
  const { rows } = await query(
    `UPDATE users
     SET full_name = COALESCE($2, full_name),
         email = CASE WHEN $3::boolean THEN $4 ELSE email END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${USER_FIELDS}`,
    [userId, fullName ?? null, email !== undefined, email ?? null],
  );
  return rows[0];
};

// ── Địa chỉ ─────────────────────────────────────────────────────────────────

const ADDRESS_FIELDS = `id, label, address_text,
  ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, is_default, created_at`;

export const listAddresses = async (customerId) => {
  const { rows } = await query(
    `SELECT ${ADDRESS_FIELDS} FROM customer_addresses
     WHERE customer_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [customerId],
  );
  return rows;
};

export const createAddress = (customerId, { label, addressText, lat, lng, isDefault }) =>
  withTransaction(async (db) => {
    const { rows: existing } = await sql(db, 
      'SELECT COUNT(*)::int AS n FROM customer_addresses WHERE customer_id = $1',
      [customerId],
    );
    if (existing[0].n >= 10) throw new AppError(400, 'Chỉ lưu được tối đa 10 địa chỉ');

    const makeDefault = isDefault || existing[0].n === 0;
    if (makeDefault) {
      await sql(db, 'UPDATE customer_addresses SET is_default = FALSE WHERE customer_id = $1', [customerId]);
    }
    const { rows } = await sql(db, 
      `INSERT INTO customer_addresses (customer_id, label, address_text, location, is_default)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography, $6)
       RETURNING ${ADDRESS_FIELDS}`,
      [customerId, label, addressText, lat, lng, makeDefault],
    );
    return rows[0];
  });

export const updateAddress = (customerId, id, data) =>
  withTransaction(async (db) => {
    const { rows: found } = await sql(db, 
      'SELECT id FROM customer_addresses WHERE id = $1 AND customer_id = $2 FOR UPDATE',
      [id, customerId],
    );
    if (!found[0]) throw new AppError(404, 'Không tìm thấy địa chỉ');

    if (data.isDefault) {
      await sql(db, 'UPDATE customer_addresses SET is_default = FALSE WHERE customer_id = $1', [customerId]);
    }
    const hasPoint = data.lat !== undefined && data.lng !== undefined;
    const { rows } = await sql(db, 
      `UPDATE customer_addresses SET
         label = CASE WHEN $3::boolean THEN $4 ELSE label END,
         address_text = COALESCE($5, address_text),
         location = CASE WHEN $6::boolean THEN ST_SetSRID(ST_MakePoint($8, $7), 4326)::geography ELSE location END,
         is_default = CASE WHEN $9::boolean THEN TRUE ELSE is_default END
       WHERE id = $1 AND customer_id = $2
       RETURNING ${ADDRESS_FIELDS}`,
      [
        id, customerId,
        data.label !== undefined, data.label ?? null,
        data.addressText ?? null,
        hasPoint, data.lat ?? 0, data.lng ?? 0,
        data.isDefault === true,
      ],
    );
    return rows[0];
  });

export const deleteAddress = (customerId, id) =>
  withTransaction(async (db) => {
    const { rows } = await sql(db, 
      'DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2 RETURNING is_default',
      [id, customerId],
    );
    if (!rows[0]) throw new AppError(404, 'Không tìm thấy địa chỉ');
    // Xoá địa chỉ mặc định => lấy địa chỉ mới nhất còn lại làm mặc định
    if (rows[0].is_default) {
      await sql(db, 
        `UPDATE customer_addresses SET is_default = TRUE
         WHERE id = (SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1)`,
        [customerId],
      );
    }
  });

// ── Danh mục dịch vụ (chỉ phần đang bật) ───────────────────────────────────

export const listCategories = async () => {
  const { rows } = await query(
    `SELECT c.id, c.name, c.icon_url, c.description, c.sort_order,
            COUNT(s.id) FILTER (WHERE s.is_active)::int AS service_count
     FROM service_categories c
     LEFT JOIN services s ON s.category_id = c.id
     WHERE c.is_active
     GROUP BY c.id
     ORDER BY c.sort_order, c.name`,
  );
  return rows;
};

export const listServices = async ({ categoryId, search }) => {
  const { rows } = await query(
    `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.description,
            s.base_price::float8 AS base_price, s.unit, s.warranty_days
     FROM services s
     JOIN service_categories c ON c.id = s.category_id
     WHERE s.is_active AND c.is_active
       AND ($1::int IS NULL OR s.category_id = $1)
       AND ($2::text IS NULL OR s.name ILIKE '%' || $2 || '%')
     ORDER BY c.sort_order, c.name, s.name`,
    [categoryId ?? null, search || null],
  );
  return rows;
};
