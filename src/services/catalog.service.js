import { query } from '../config/db.js';
import { AppError } from '../utils/AppError.js';

const buildUpdate = (data, allowed) => {
  const keys = allowed.filter((key) => data[key] !== undefined);
  if (!keys.length) throw new AppError(400, 'Không có thông tin nào để cập nhật');
  return {
    set: keys.map((key, i) => `${key} = $${i + 2}`).join(', '),
    values: keys.map((key) => data[key]),
  };
};

export const listCategories = async () => {
  const { rows } = await query(
    `SELECT c.id, c.name, c.icon_url, c.description, c.sort_order, c.is_active, c.created_at,
            COUNT(s.id)::int AS service_count
     FROM service_categories c
     LEFT JOIN services s ON s.category_id = c.id
     GROUP BY c.id
     ORDER BY c.sort_order, c.name`,
  );
  return rows;
};

export const createCategory = async (data) => {
  const { rows } = await query(
    `INSERT INTO service_categories (name, icon_url, description, sort_order)
     VALUES ($1, $2, $3, COALESCE($4, 0))
     RETURNING *`,
    [data.name, data.icon_url ?? null, data.description ?? null, data.sort_order ?? null],
  );
  return rows[0];
};

export const updateCategory = async (id, data) => {
  const { set, values } = buildUpdate(data, ['name', 'icon_url', 'description', 'sort_order', 'is_active']);
  const { rows } = await query(
    `UPDATE service_categories SET ${set} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy danh mục');
  return rows[0];
};

export const listServices = async ({ categoryId, search }) => {
  const params = [];
  const conditions = ['TRUE'];

  if (categoryId) {
    params.push(categoryId);
    conditions.push(`s.category_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`s.name ILIKE $${params.length}`);
  }

  const { rows } = await query(
    `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.description,
            s.base_price::float8 AS base_price, s.unit, s.warranty_days, s.is_active, s.updated_at,
            (SELECT COUNT(*) FROM orders o WHERE o.service_id = s.id)::int AS order_count
     FROM services s
     JOIN service_categories c ON c.id = s.category_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.sort_order, c.name, s.name`,
    params,
  );
  return rows;
};

export const createService = async (data) => {
  const { rows } = await query(
    `INSERT INTO services (category_id, name, description, base_price, unit, warranty_days)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'lần'), COALESCE($6, 0))
     RETURNING *`,
    [data.category_id, data.name, data.description ?? null, data.base_price, data.unit ?? null, data.warranty_days ?? null],
  );
  return rows[0];
};

export const updateService = async (id, data) => {
  const { set, values } = buildUpdate(data, [
    'category_id', 'name', 'description', 'base_price', 'unit', 'warranty_days', 'is_active',
  ]);
  const { rows } = await query(
    `UPDATE services SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy dịch vụ');
  return rows[0];
};