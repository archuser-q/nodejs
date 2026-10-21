import { pool, query } from '../config/db.js';
import { AppError } from '../utils/AppError.js';

export const listWorkers = async ({ search, verification, status, page, pageSize }) => {
  const params = [];
  const conditions = [`u.role = 'worker'`];

  if (status) {
    params.push(status);
    conditions.push(`u.status = $${params.length}`);
  } else {
    conditions.push(`u.status <> 'deleted'`);
  }

  if (verification) {
    params.push(verification);
    conditions.push(`w.verification_status = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone ILIKE ${p})`);
  }

  params.push(pageSize, (page - 1) * pageSize);

  const { rows } = await query(
    `SELECT u.id, u.full_name, u.phone, u.email, u.avatar_url, u.status, u.created_at,
            w.verification_status, w.is_online, w.experience_years, w.total_jobs,
            w.rating_avg::float8 AS rating_avg, w.rating_count, w.trust_score::float8 AS trust_score,
            COALESCE((SELECT array_agg(c.name ORDER BY c.name)
                      FROM worker_skills ws JOIN service_categories c ON c.id = ws.category_id
                      WHERE ws.worker_id = u.id), '{}') AS skills,
            COUNT(*) OVER()::int AS total
     FROM users u
     JOIN workers w ON w.user_id = u.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY (w.verification_status = 'pending') DESC, u.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const total = rows[0]?.total ?? 0;
  return { items: rows.map(({ total, ...worker }) => worker), total };
};

export const getWorkerDetail = async (id) => {
  const [profile, skills, documents, stats, reviews] = await Promise.all([
    query(
      `SELECT u.id, u.full_name, u.phone, u.email, u.avatar_url, u.status, u.created_at, u.last_login_at,
              w.bio, w.experience_years, w.verification_status, w.verification_note, w.verified_at,
              w.is_online, w.service_radius_km::float8 AS service_radius_km,
              w.rating_avg::float8 AS rating_avg, w.rating_count, w.trust_score::float8 AS trust_score,
              w.is_flagged, w.total_jobs, w.acceptance_rate::float8 AS acceptance_rate,
              w.cancel_rate::float8 AS cancel_rate, w.wallet_balance::float8 AS wallet_balance
       FROM users u JOIN workers w ON w.user_id = u.id
       WHERE u.id = $1`,
      [id],
    ),
    query(
      `SELECT c.id, c.name, ws.years
       FROM worker_skills ws JOIN service_categories c ON c.id = ws.category_id
       WHERE ws.worker_id = $1 ORDER BY c.name`,
      [id],
    ),
    query(
      `SELECT id, doc_type, file_url, status, reject_reason, created_at, reviewed_at
       FROM worker_documents WHERE worker_id = $1 ORDER BY created_at`,
      [id],
    ),
    query(
      `SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_orders,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_orders,
              COALESCE(SUM(final_price) FILTER (WHERE status = 'completed'), 0)::float8 AS total_revenue
       FROM orders WHERE worker_id = $1`,
      [id],
    ),
    query(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.full_name AS customer_name
       FROM reviews r JOIN users u ON u.id = r.customer_id
       WHERE r.worker_id = $1 ORDER BY r.created_at DESC LIMIT 5`,
      [id],
    ),
  ]);

  if (!profile.rows[0]) throw new AppError(404, 'Worker not found');

  return {
    worker: profile.rows[0],
    skills: skills.rows,
    documents: documents.rows,
    stats: stats.rows[0],
    recentReviews: reviews.rows,
  };
};

export const reviewWorker = async (id, adminId, status, note) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE workers
       SET verification_status = $2, verification_note = $3, verified_at = NOW(), verified_by = $4, updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id AS id, verification_status`,
      [id, status, note, adminId],
    );
    if (!rows[0]) throw new AppError(404, 'Worker not found');

    await client.query(
      `UPDATE worker_documents
       SET status = $2, reviewed_by = $3, reviewed_at = NOW(), reject_reason = $4
       WHERE worker_id = $1 AND status <> $2`,
      [id, status, adminId, status === 'rejected' ? note : null],
    );

    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  } 
};