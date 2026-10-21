import { pool, query } from '../config/db.js';
import { AppError } from '../utils/AppError.js';

// Hồ sơ cần admin xử lý: đã bấm "Gửi hồ sơ" và đang chờ duyệt, hoặc thợ đã duyệt nhưng gửi giấy tờ mới
const NEEDS_REVIEW = `((w.verification_status = 'pending' AND w.submitted_at IS NOT NULL)
  OR (w.verification_status = 'approved' AND EXISTS (
        SELECT 1 FROM worker_documents d WHERE d.worker_id = w.user_id AND d.status = 'pending')))`;

export const listWorkers = async ({ search, verification, status, review, page, pageSize }) => {
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

  if (review === 'needed') conditions.push(NEEDS_REVIEW);

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone ILIKE ${p})`);
  }

  params.push(pageSize, (page - 1) * pageSize);

  const { rows } = await query(
    `SELECT u.id, u.full_name, u.phone, u.email, u.avatar_url, u.status, u.created_at,
            w.verification_status, w.submitted_at, w.is_online, w.is_busy, w.experience_years, w.total_jobs,
            (SELECT COUNT(*) FROM worker_documents d WHERE d.worker_id = w.user_id AND d.status = 'pending')::int AS pending_docs,
            ${NEEDS_REVIEW} AS needs_review,
            w.rating_avg::float8 AS rating_avg, w.rating_count, w.trust_score::float8 AS trust_score,
            COALESCE((SELECT array_agg(c.name ORDER BY c.name)
                      FROM worker_skills ws JOIN service_categories c ON c.id = ws.category_id
                      WHERE ws.worker_id = u.id), '{}') AS skills,
            COUNT(*) OVER()::int AS total
     FROM users u
     JOIN workers w ON w.user_id = u.id
     WHERE ${conditions.join(' AND ')}
     -- hồ sơ cần duyệt lên đầu, gửi trước duyệt trước; còn lại mới đăng ký lên trước
     ORDER BY ${NEEDS_REVIEW} DESC, w.submitted_at ASC NULLS LAST, u.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const total = rows[0]?.total ?? 0;
  return { items: rows.map(({ total, ...worker }) => worker), total };
};

export const getWorkerDetail = async (id) => {
  const [profile, skills, documents, stats, reviews, bank] = await Promise.all([
    query(
      `SELECT u.id, u.full_name, u.phone, u.email, u.avatar_url, u.status, u.created_at, u.last_login_at,
              w.bio, w.experience_years, w.verification_status, w.verification_note, w.verified_at, w.submitted_at,
              vb.full_name AS verified_by_name, w.is_busy, w.location_updated_at,
              w.is_online, w.service_radius_km::float8 AS service_radius_km,
              w.rating_avg::float8 AS rating_avg, w.rating_count, w.trust_score::float8 AS trust_score,
              w.is_flagged, w.total_jobs, w.acceptance_rate::float8 AS acceptance_rate,
              w.cancel_rate::float8 AS cancel_rate, w.wallet_balance::float8 AS wallet_balance
       FROM users u JOIN workers w ON w.user_id = u.id
       LEFT JOIN users vb ON vb.id = w.verified_by
       WHERE u.id = $1 AND u.role = 'worker'`,
      [id],
    ),
    query(
      `SELECT c.id, c.name, ws.years
       FROM worker_skills ws JOIN service_categories c ON c.id = ws.category_id
       WHERE ws.worker_id = $1 ORDER BY c.name`,
      [id],
    ),
    // is_current: bản mới nhất của từng loại giấy (CCCD, chân dung). Chứng chỉ thì bản nào cũng tính.
    query(
      `SELECT d.id, d.doc_type, d.file_url, d.status, d.reject_reason, d.created_at, d.reviewed_at,
              r.full_name AS reviewed_by_name,
              (d.doc_type = 'certificate' OR d.id = (
                 SELECT x.id FROM worker_documents x WHERE x.worker_id = d.worker_id AND x.doc_type = d.doc_type
                 ORDER BY x.created_at DESC, x.id DESC LIMIT 1)) AS is_current
       FROM worker_documents d
       LEFT JOIN users r ON r.id = d.reviewed_by
       WHERE d.worker_id = $1
       ORDER BY array_position(ARRAY['id_card_front','id_card_back','portrait','certificate','other']::text[], d.doc_type::text),
                d.created_at DESC, d.id DESC`,
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
    query(
      `SELECT bank_name, account_number, account_holder, updated_at FROM worker_bank_accounts WHERE worker_id = $1`,
      [id],
    ),
  ]);

  if (!profile.rows[0]) throw new AppError(404, 'Không tìm thấy thợ');

  return {
    worker: profile.rows[0],
    skills: skills.rows,
    documents: documents.rows,
    stats: stats.rows[0],
    recentReviews: reviews.rows,
    bankAccount: bank.rows[0] ?? null,
  };
};

const DOC_LABEL = {
  id_card_front: 'CCCD mặt trước',
  id_card_back: 'CCCD mặt sau',
  portrait: 'Ảnh chân dung',
  certificate: 'Chứng chỉ nghề',
  other: 'Giấy tờ khác',
};
// Trùng với REQUIRED_DOCS của app thợ (services/worker/profile.service.js)
const REQUIRED_DOCS = ['id_card_front', 'id_card_back', 'portrait'];

const lockWorker = async (client, id) => {
  const { rows } = await client.query(
    `SELECT w.user_id AS id, w.verification_status, w.submitted_at
     FROM workers w JOIN users u ON u.id = w.user_id
     WHERE w.user_id = $1 AND u.role = 'worker' FOR UPDATE OF w`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy thợ');
  return rows[0];
};

/**
 * Duyệt / từ chối cả hồ sơ.
 *  - Duyệt: duyệt luôn các giấy tờ đang chờ; mỗi giấy bắt buộc phải có ít nhất 1 bản đã duyệt.
 *  - Từ chối: chỉ đổi trạng thái hồ sơ + ghi lý do chung. Giấy tờ hợp lệ giữ nguyên,
 *    giấy nào sai thì admin từ chối riêng giấy đó (reviewDocument) để thợ chỉ phải tải lại đúng giấy đó.
 */
export const reviewWorker = async (id, adminId, status, note) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockWorker(client, id);

    if (status === 'approved') {
      await client.query(
        `UPDATE worker_documents
         SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), reject_reason = NULL
         WHERE worker_id = $1 AND status = 'pending'`,
        [id, adminId],
      );
      const { rows: ok } = await client.query(
        `SELECT DISTINCT doc_type::text AS doc_type FROM worker_documents WHERE worker_id = $1 AND status = 'approved'`,
        [id],
      );
      const have = new Set(ok.map((r) => r.doc_type));
      const missing = REQUIRED_DOCS.filter((t) => !have.has(t)).map((t) => DOC_LABEL[t]);
      if (missing.length) throw new AppError(400, `Chưa duyệt được: còn thiếu giấy tờ hợp lệ (${missing.join(', ')})`);
    }

    const { rows } = await client.query(
      `UPDATE workers
       SET verification_status = $2, verification_note = $3, verified_at = NOW(), verified_by = $4, updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id AS id, verification_status`,
      [id, status, status === 'rejected' ? note : null, adminId],
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

/**
 * Duyệt / từ chối từng giấy tờ. Trả về giấy tờ + trạng thái hồ sơ hiện tại để controller quyết định có báo thợ không
 * (hồ sơ đang chờ duyệt thì đợi admin chốt cả hồ sơ mới báo; thợ đã duyệt gửi giấy mới thì báo ngay).
 */
export const reviewDocument = async (workerId, docId, adminId, status, reason) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const worker = await lockWorker(client, workerId);

    const { rows } = await client.query(
      `UPDATE worker_documents
       SET status = $3, reject_reason = $4, reviewed_by = $5, reviewed_at = NOW()
       WHERE id = $1 AND worker_id = $2
       RETURNING id, doc_type, file_url, status, reject_reason, created_at, reviewed_at`,
      [docId, workerId, status, status === 'rejected' ? reason : null, adminId],
    );
    if (!rows[0]) throw new AppError(404, 'Không tìm thấy giấy tờ');

    // Thợ đang hoạt động mà giấy bắt buộc không còn bản nào hợp lệ -> không còn đủ điều kiện (vd. CCCD giả)
    if (worker.verification_status === 'approved' && status === 'rejected' && REQUIRED_DOCS.includes(rows[0].doc_type)) {
      const { rows: left } = await client.query(
        `SELECT 1 FROM worker_documents WHERE worker_id = $1 AND doc_type = $2 AND status = 'approved' LIMIT 1`,
        [workerId, rows[0].doc_type],
      );
      if (!left.length) {
        throw new AppError(400, `Đây là ${DOC_LABEL[rows[0].doc_type]} hợp lệ duy nhất của thợ. Muốn huỷ tư cách thợ, hãy từ chối cả hồ sơ hoặc khoá tài khoản`);
      }
    }

    await client.query('COMMIT');
    return { document: rows[0], label: DOC_LABEL[rows[0].doc_type] ?? 'Giấy tờ', verification_status: worker.verification_status };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
