/**
 * App thợ: hồ sơ, kỹ năng, giấy tờ xác minh, tài khoản ngân hàng, bật/tắt nhận đơn, vị trí, trang chủ.  [Thành viên B]
 */
import { pool, q, sql } from '../../config/db.js';
import { settings } from '../../config/settings.js';
import { AppError } from '../../utils/AppError.js';
import { transaction } from '../../utils/tx.js';
import { emitToUser } from '../../realtime/socket.js';
import { USER_FIELDS } from '../../middlewares/requireCustomer.js';
import { notify } from '../shared/notify.service.js';
import { getConfig } from '../matching/config.js';
import { withdrawWorkerOffers } from '../matching/dispatch.service.js';
import { getBank, incomeBetween } from './finance.service.js';
import { workerLevel } from './level.js';
import { INFLIGHT_STATUSES, OPEN_JOB_STATUSES, availabilityOf, refreshAvailability } from './state.js';
import { DAY, vnDayStart } from './time.js';

export const REQUIRED_DOCS = ['id_card_front', 'id_card_back', 'portrait'];
export const DOC_TYPES = [...REQUIRED_DOCS, 'certificate'];
export const DOC_LABEL = {
  id_card_front: 'CCCD mặt trước',
  id_card_back: 'CCCD mặt sau',
  portrait: 'Ảnh chân dung',
  certificate: 'Chứng chỉ nghề',
};
const MAX_CERTIFICATES = 5;
const LOCATION_LOG_EVERY_SECONDS = 20;

const WORKER_FIELDS = `w.user_id, w.bio, w.experience_years, w.verification_status, w.verification_note, w.submitted_at,
  w.is_online, w.is_busy, w.service_radius_km, w.rating_avg, w.rating_count, w.trust_score, w.total_jobs,
  w.acceptance_rate, w.cancel_rate, w.wallet_balance, w.location_updated_at,
  ST_Y(w.current_location::geometry) AS latitude, ST_X(w.current_location::geometry) AS longitude`;

// ── Dùng chung ──────────────────────────────────────────────────────────────

export async function getWorker(db, userId, forUpdate = false) {
  const load = () => sql(db, `SELECT ${WORKER_FIELDS} FROM workers w WHERE w.user_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [userId]);
  let { rows } = await load();
  if (!rows[0]) {
    // Tài khoản thợ tạo trước khi có hồ sơ: tạo bù
    await sql(db, 'INSERT INTO workers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    ({ rows } = await load());
  }
  return rows[0];
}

const ratingOf = (w) => (w.rating_count > 0 ? Number(w.rating_avg) : null);

const locationOf = (w) =>
  w.latitude === null || w.latitude === undefined
    ? null
    : { latitude: w.latitude, longitude: w.longitude, updated_at: w.location_updated_at };

export const isLocationFresh = (w) => {
  if (!w.location_updated_at || w.latitude === null) return false;
  if (!settings.locationMaxAgeMinutes) return true;
  return Date.now() - new Date(w.location_updated_at).getTime() <= settings.locationMaxAgeMinutes * 60_000;
};

async function skillsOf(db, workerId) {
  const { rows } = await sql(
    db,
    `SELECT ws.category_id, c.name AS category_name, ws.years,
            (SELECT COUNT(*) FROM services s WHERE s.category_id = c.id AND s.is_active)::int AS service_count
     FROM worker_skills ws JOIN service_categories c ON c.id = ws.category_id
     WHERE ws.worker_id = $1 ORDER BY c.sort_order, c.name`,
    [workerId],
  );
  return rows;
}

async function documentsOf(db, workerId) {
  const { rows } = await sql(
    db,
    `SELECT id, doc_type, file_url, status, reject_reason, created_at, reviewed_at
     FROM worker_documents WHERE worker_id = $1 ORDER BY created_at DESC, id DESC`,
    [workerId],
  );
  return rows;
}

function onboardingOf(user, w, skillsCount, docs) {
  const latest = {};
  const usable = new Set();
  for (const d of docs) {
    // docs đã sắp mới -> cũ
    latest[d.doc_type] ??= d;
    if (d.status === 'pending' || d.status === 'approved') usable.add(d.doc_type);
  }
  const missing = [];
  if (!user.phone) missing.push('Thêm số điện thoại liên hệ');
  if (!skillsCount) missing.push('Chọn ít nhất 1 nhóm dịch vụ nhận làm');
  for (const t of REQUIRED_DOCS) {
    if (usable.has(t)) continue;
    const label = DOC_LABEL[t].startsWith('CCCD') ? DOC_LABEL[t] : DOC_LABEL[t][0].toLowerCase() + DOC_LABEL[t].slice(1);
    missing.push(`${latest[t]?.status === 'rejected' ? 'Tải lại' : 'Tải lên'} ${label}`);
  }
  // Lý do chung của lần từ chối hồ sơ luôn hiện 1 lần ở đầu (kể cả khi giấy tờ không bị đánh dấu riêng).
  // Admin từ chối cả hồ sơ thì mọi giấy tờ cùng mang lý do đó -> không lặp lại theo từng ảnh,
  // chỉ liệt kê thêm ảnh nào có lý do riêng.
  const note = w.verification_status === 'rejected' ? w.verification_note?.trim() || null : null;
  const reasons = Object.values(latest)
    .filter((d) => d.status === 'rejected' && d.reject_reason && d.reject_reason.trim() !== note)
    .map((d) => `${DOC_LABEL[d.doc_type] ?? d.doc_type}: ${d.reject_reason}`);
  if (note) reasons.unshift(`Hồ sơ bị từ chối: ${note}`);

  return {
    verification_status: w.verification_status,
    submitted_at: w.submitted_at,
    has_phone: !!user.phone,
    has_skills: skillsCount > 0,
    documents: Object.fromEntries(DOC_TYPES.map((t) => [t, latest[t]?.status ?? null])),
    reject_reasons: reasons,
    missing,
    can_submit: !missing.length && w.verification_status !== 'approved' && (!w.submitted_at || w.verification_status === 'rejected'),
  };
}

/**
 * Trạng thái hồ sơ xác minh theo góc nhìn của thợ:
 *  approved · pending (đã gửi, chờ admin) · rejected (bị từ chối, sửa rồi gửi lại) · not_submitted (chưa gửi)
 */
export const reviewStateOf = (w) =>
  w.verification_status === 'approved'
    ? 'approved'
    : w.verification_status === 'rejected'
      ? 'rejected'
      : w.submitted_at
        ? 'pending'
        : 'not_submitted';

/** Lý do thợ chưa thể bật nhận đơn (rỗng = được bật). Câu đầu tiên là câu app hiển thị khi bấm bật nhận đơn. */
function blockersOf(user, w, skillsCount) {
  const out = [];
  const state = reviewStateOf(w);
  if (state === 'not_submitted') out.push('Bạn chưa gửi hồ sơ xác minh. Hãy nộp giấy tờ (CCCD, ảnh chân dung) để được duyệt và nhận việc');
  if (state === 'pending') out.push('Hồ sơ của bạn đang chờ quản trị viên duyệt. Bạn sẽ nhận được thông báo khi có kết quả');
  if (state === 'rejected') {
    out.push(`Hồ sơ chưa được duyệt${w.verification_note ? `: ${w.verification_note}` : ''}. Hãy cập nhật giấy tờ rồi gửi lại`);
  }
  if (!user.phone) out.push('Chưa có số điện thoại liên hệ');
  if (!skillsCount) out.push('Chưa chọn nhóm dịch vụ nhận làm');
  return out;
}

const profileOut = (w) => ({
  bio: w.bio,
  experience_years: w.experience_years,
  service_radius_km: w.service_radius_km,
  availability: availabilityOf(w),
  verification_status: w.verification_status,
  verification_note: w.verification_note,
  review_state: reviewStateOf(w),
  submitted_at: w.submitted_at,
  trust_score: w.trust_score,
  rating_avg: ratingOf(w),
  rating_count: w.rating_count,
  total_jobs: w.total_jobs,
  acceptance_rate: w.acceptance_rate,
  cancel_rate: w.cancel_rate,
  wallet_balance: w.wallet_balance,
  location: locationOf(w),
  level: workerLevel(w.total_jobs, ratingOf(w)),
});

// ── Hồ sơ ───────────────────────────────────────────────────────────────────

export async function me(userId) {
  const { rows: u } = await q(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [userId]);
  const user = u[0];
  const w = await getWorker(pool, userId);
  const [skills, docs, bank] = await Promise.all([skillsOf(pool, userId), documentsOf(pool, userId), getBank(pool, userId)]);
  return {
    user,
    profile: profileOut(w),
    skills,
    documents: docs,
    bank_account: bank,
    onboarding: onboardingOf(user, w, skills.length, docs),
    settings: {
      commission_rate: settings.commissionRate,
      min_withdrawal: settings.minWithdrawal,
      // true: lệnh rút được duyệt ngay (demo); false: chờ admin duyệt ở trang Tài chính của web quản trị
      withdrawal_auto_approve: settings.withdrawalAutoApprove,
      location_max_age_minutes: settings.locationMaxAgeMinutes,
    },
  };
}

export async function updateProfile(userId, f) {
  if (f.phone !== undefined) {
    const { rows } = await q('SELECT 1 FROM users WHERE phone = $1 AND id <> $2', [f.phone, userId]);
    if (rows.length) throw new AppError(409, 'Số điện thoại đã được dùng cho tài khoản khác');
  }
  await transaction(async (db) => {
    await sql(
      db,
      `UPDATE users SET
         full_name = COALESCE($2, full_name),
         phone = COALESCE($3, phone),
         avatar_url = CASE WHEN $4::boolean THEN $5 ELSE avatar_url END,
         updated_at = NOW()
       WHERE id = $1`,
      [userId, f.full_name ?? null, f.phone ?? null, f.avatar_url !== undefined, f.avatar_url ?? null],
    );
    await getWorker(db, userId);
    await sql(
      db,
      `UPDATE workers SET
         bio = CASE WHEN $2::boolean THEN $3 ELSE bio END,
         experience_years = COALESCE($4, experience_years),
         service_radius_km = COALESCE($5, service_radius_km),
         updated_at = NOW()
       WHERE user_id = $1`,
      [userId, f.bio !== undefined, f.bio ?? null, f.experience_years ?? null, f.service_radius_km ?? null],
    );
    // Số năm kinh nghiệm là con số chung, áp dụng cho mọi nhóm dịch vụ đã chọn (tiêu chí kỹ năng khi ghép cặp)
    if (f.experience_years !== undefined && f.experience_years !== null) {
      await sql(db, 'UPDATE worker_skills SET years = $2 WHERE worker_id = $1', [userId, f.experience_years]);
    }
  });
  return me(userId);
}

/**
 * Chọn nhóm dịch vụ (danh mục) nhận làm. Số năm kinh nghiệm ở mỗi nhóm = số năm kinh nghiệm chung của thợ
 * (workers.experience_years) -> cột worker_skills.years mà hàm điểm ghép cặp (tiêu chí kỹ năng) đang đọc.
 */
export async function setSkills(userId, categoryIds) {
  const ids = [...new Set(categoryIds)];
  const { rows } = await q('SELECT id FROM service_categories WHERE id = ANY($1::int[]) AND is_active', [ids]);
  if (rows.length !== ids.length) throw new AppError(400, 'Có nhóm dịch vụ không tồn tại hoặc đã ngừng');
  await transaction(async (db) => {
    const w = await getWorker(db, userId);
    await sql(db, 'DELETE FROM worker_skills WHERE worker_id = $1', [userId]);
    for (const id of ids) {
      await sql(db, 'INSERT INTO worker_skills (worker_id, category_id, years) VALUES ($1, $2, $3)', [userId, id, w.experience_years]);
    }
  });
  return skillsOf(pool, userId);
}

// ── Giấy tờ xác minh ────────────────────────────────────────────────────────

export const listDocuments = (userId) => documentsOf(pool, userId);

export async function addDocument(userId, docType, fileUrl) {
  const result = await transaction(async (db, after) => {
    const w = await getWorker(db, userId, true);
    let doc;
    if (docType === 'certificate') {
      const { rows } = await sql(
        db,
        "SELECT COUNT(*)::int AS n FROM worker_documents WHERE worker_id = $1 AND doc_type = 'certificate' AND status <> 'rejected'",
        [userId],
      );
      if (rows[0].n >= MAX_CERTIFICATES) throw new AppError(400, `Tối đa ${MAX_CERTIFICATES} chứng chỉ`);
    } else {
      // Giấy tờ bắt buộc đã duyệt vẫn cập nhật được (VD làm CCCD mới) nhưng KHÔNG thay ngay: ảnh mới chờ duyệt,
      // ảnh cũ vẫn có hiệu lực tới khi admin duyệt ảnh mới -> chống mạo danh mà thợ vẫn nhận việc bình thường.
      // Đang có bản chờ duyệt thì thay ảnh, không tạo bản trùng.
      const { rows } = await sql(
        db,
        `UPDATE worker_documents SET file_url = $3, created_at = NOW()
         WHERE id = (SELECT id FROM worker_documents WHERE worker_id = $1 AND doc_type = $2 AND status = 'pending'
                     ORDER BY created_at DESC LIMIT 1)
         RETURNING id, doc_type, file_url, status, reject_reason, created_at, reviewed_at`,
        [userId, docType, fileUrl],
      );
      doc = rows[0];
    }
    if (!doc) {
      const { rows } = await sql(
        db,
        `INSERT INTO worker_documents (worker_id, doc_type, file_url) VALUES ($1, $2, $3)
         RETURNING id, doc_type, file_url, status, reject_reason, created_at, reviewed_at`,
        [userId, docType, fileUrl],
      );
      doc = rows[0];
    }
    const { rows: approved } = await sql(
      db,
      "SELECT 1 FROM worker_documents WHERE worker_id = $1 AND doc_type = $2 AND status = 'approved' LIMIT 1",
      [userId, docType],
    );
    const replacing = docType !== 'certificate' && approved.length > 0;
    if (w.verification_status === 'approved') after(() => notifyAdmins('Thợ cập nhật giấy tờ', `Thợ #${userId} gửi ${DOC_LABEL[docType]} mới, cần duyệt lại`, userId));
    return {
      document: doc,
      message: replacing ? `Đã gửi ${DOC_LABEL[docType]} mới, ảnh cũ vẫn dùng đến khi được duyệt` : `Đã tải lên ${DOC_LABEL[docType]}`,
    };
  });
  return result;
}

export async function deleteDocument(userId, docId) {
  const { rows } = await q('SELECT id, doc_type, status FROM worker_documents WHERE id = $1 AND worker_id = $2', [docId, userId]);
  const doc = rows[0];
  if (!doc) throw new AppError(404, 'Không tìm thấy giấy tờ');
  // Chứng chỉ (không bắt buộc) gỡ được kể cả đã duyệt; CCCD/chân dung đã duyệt là căn cứ xác minh nên không gỡ
  if (doc.status === 'approved' && doc.doc_type !== 'certificate') {
    throw new AppError(400, `${DOC_LABEL[doc.doc_type] ?? 'Giấy tờ'} đã duyệt không gỡ được. Muốn đổi, hãy gửi ảnh mới để duyệt lại`);
  }
  await q('DELETE FROM worker_documents WHERE id = $1', [docId]);
}

async function notifyAdmins(title, body, workerId) {
  const { rows } = await q("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
  for (const a of rows) await notify(a.id, { title, body, type: 'worker_verification', data: { worker_id: workerId } });
}

export async function submitVerification(userId) {
  await transaction(async (db, after) => {
    const w = await getWorker(db, userId, true);
    const { rows: u } = await sql(db, `SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [userId]);
    const skills = await skillsOf(db, userId);
    const status = onboardingOf(u[0], w, skills.length, await documentsOf(db, userId));
    if (w.verification_status === 'approved') throw new AppError(400, 'Hồ sơ đã được duyệt');
    if (status.missing.length) throw new AppError(400, `Hồ sơ còn thiếu: ${status.missing.join('; ')}`);
    if (!status.can_submit) throw new AppError(400, 'Hồ sơ đã được gửi, vui lòng chờ duyệt');
    await sql(
      db,
      "UPDATE workers SET submitted_at = NOW(), verification_status = 'pending', updated_at = NOW() WHERE user_id = $1",
      [userId],
    );
    after(() => notifyAdmins('Hồ sơ thợ chờ duyệt', `${u[0].full_name} vừa gửi hồ sơ xác minh`, userId));
  });
  return me(userId);
}

// ── Tài khoản ngân hàng ─────────────────────────────────────────────────────

export async function setBank(userId, { bank_name, account_number, account_holder }) {
  await getWorker(pool, userId);
  await q(
    `INSERT INTO worker_bank_accounts (worker_id, bank_name, account_number, account_holder)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (worker_id) DO UPDATE SET bank_name = EXCLUDED.bank_name, account_number = EXCLUDED.account_number,
       account_holder = EXCLUDED.account_holder, updated_at = NOW()`,
    [userId, bank_name, account_number, account_holder],
  );
  return getBank(pool, userId);
}

// ── Bật/tắt nhận đơn, vị trí ────────────────────────────────────────────────

async function applyLocation(db, userId, lat, lng) {
  await sql(
    db,
    `UPDATE workers SET current_location = ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography,
            location_updated_at = NOW(), updated_at = NOW()
     WHERE user_id = $1`,
    [userId, lat, lng],
  );
  // Đang làm đơn: lưu vết đường đi (thưa: tối đa 1 điểm / 20 giây) + đẩy vị trí cho khách theo dõi
  const { rows } = await sql(
    db,
    `SELECT id, customer_id, status FROM orders
     WHERE worker_id = $1 AND status = ANY($2::order_status[])
     ORDER BY (status = ANY($3::order_status[])) DESC, accepted_at DESC LIMIT 1`,
    [userId, OPEN_JOB_STATUSES, INFLIGHT_STATUSES],
  );
  const job = rows[0];
  if (!job) return null;
  if (INFLIGHT_STATUSES.includes(job.status)) {
    await sql(
      db,
      `INSERT INTO worker_location_logs (worker_id, order_id, location)
       SELECT $1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography
       WHERE NOT EXISTS (SELECT 1 FROM worker_location_logs
                         WHERE worker_id = $1 AND recorded_at > NOW() - make_interval(secs => $5))`,
      [userId, job.id, lat, lng, LOCATION_LOG_EVERY_SECONDS],
    );
  }
  return job;
}

export async function updateLocation(userId, lat, lng) {
  const job = await transaction(async (db) => {
    await getWorker(db, userId);
    return applyLocation(db, userId, lat, lng);
  });
  const updatedAt = new Date();
  if (job) emitToUser(job.customer_id, 'worker:location', { order_id: Number(job.id), lat, lng, updated_at: updatedAt });
  return { latitude: lat, longitude: lng, location_updated_at: updatedAt };
}

export async function setAvailability(userId, online, coords) {
  return transaction(async (db, after) => {
    await getWorker(db, userId, true);
    let job = null;
    if (coords) job = await applyLocation(db, userId, coords.latitude, coords.longitude);
    if (online) {
      const { rows: u } = await sql(db, 'SELECT phone FROM users WHERE id = $1', [userId]);
      const w = await getWorker(db, userId);
      const skills = await skillsOf(db, userId);
      const problems = blockersOf(u[0], w, skills.length);
      if (problems.length) throw new AppError(400, problems[0]);
      if (!isLocationFresh(w)) throw new AppError(400, 'Cần bật định vị để nhận đơn quanh bạn');
      await sql(db, 'UPDATE workers SET is_online = TRUE, updated_at = NOW() WHERE user_id = $1', [userId]);
      await refreshAvailability(db, userId);
    } else {
      await sql(db, 'UPDATE workers SET is_online = FALSE, updated_at = NOW() WHERE user_id = $1', [userId]);
      await withdrawWorkerOffers(db, after, userId);
    }
    if (job && coords) {
      after(() =>
        emitToUser(job.customer_id, 'worker:location', { order_id: Number(job.id), lat: coords.latitude, lng: coords.longitude, updated_at: new Date() }),
      );
    }
    const w = await getWorker(db, userId);
    return {
      availability: availabilityOf(w),
      location_fresh: isLocationFresh(w),
      message: online ? 'Đã bật nhận đơn' : 'Đã tắt nhận đơn',
    };
  });
}

/**
 * Admin bỏ duyệt / từ chối hồ sơ: tắt nhận đơn và thu hồi lời mời đang chờ, để app không còn
 * hiện "Đang nhận đơn" với một thợ đã bị chặn (bộ ghép vốn đã bỏ qua thợ chưa duyệt).
 * Việc đang làm dở (nếu có) vẫn giữ để thợ làm nốt với khách.
 */
export async function onVerificationRevoked(userId) {
  return transaction(async (db, after) => {
    await sql(db, 'UPDATE workers SET is_online = FALSE, updated_at = NOW() WHERE user_id = $1', [userId]);
    await withdrawWorkerOffers(db, after, userId);
  });
}

// ── Trang chủ ───────────────────────────────────────────────────────────────

export async function home(userId, { currentOffer, jobItems }) {
  const { rows: u } = await q(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [userId]);
  const w = await getWorker(pool, userId);
  const today = vnDayStart();
  const [skills, todayStats, weekStats, cfg, unread, open, offer] = await Promise.all([
    skillsOf(pool, userId),
    incomeBetween(userId, today, today + DAY),
    incomeBetween(userId, today - 6 * DAY, today + DAY),
    getConfig(pool),
    q('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read', [userId]),
    q(
      `SELECT id, status, scheduled_at FROM orders
       WHERE worker_id = $1 AND status = ANY($2::order_status[])
       ORDER BY scheduled_at ASC NULLS FIRST, accepted_at`,
      [userId, OPEN_JOB_STATUSES],
    ),
    currentOffer(userId),
  ]);
  const soon = Date.now() + settings.busyBeforeScheduleMinutes * 60_000;
  const jobs = open.rows;
  const active =
    jobs.find((o) => INFLIGHT_STATUSES.includes(o.status)) ??
    jobs.find((o) => !o.scheduled_at || new Date(o.scheduled_at).getTime() <= soon) ??
    null;
  const upcoming = jobs.filter((o) => o !== active).slice(0, 5);
  const items = await jobItems(userId, [active, ...upcoming].filter(Boolean).map((o) => o.id));
  const problems = blockersOf(u[0], w, skills.length);
  const rating = ratingOf(w);
  return {
    availability: availabilityOf(w),
    verification_status: w.verification_status,
    verification_note: w.verification_note,
    review_state: reviewStateOf(w),
    can_go_online: !problems.length,
    blockers: problems,
    location_fresh: isLocationFresh(w),
    today: todayStats,
    week: weekStats,
    rating_avg: rating,
    rating_count: w.rating_count,
    trust_score: w.trust_score,
    wallet_balance: w.wallet_balance,
    current_offer: offer,
    active_job: active ? items[0] : null,
    upcoming: active ? items.slice(1) : items,
    unread_notifications: unread.rows[0].n,
    matching_mode: cfg.mode,
    location: locationOf(w),
    service_radius_km: w.service_radius_km,
    level: workerLevel(w.total_jobs, rating),
  };
}
