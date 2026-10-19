/**
 * Dữ liệu demo cho App Thợ (+ dùng chung cho app khách / web quản trị).  [Thành viên B]
 * Chạy nhiều lần không sao (không tạo trùng):  npm run seed:demo
 *
 * Mật khẩu chung: 12345678
 *   tho@thonhanh.vn       thợ đã duyệt (Trần Minh Đức) — có sẵn lịch sử 6 tuần: thu nhập, đánh giá, ví, lịch hẹn
 *   tho2@thonhanh.vn      thợ đã duyệt thứ 2 (Nguyễn Văn Bình) — demo 2 thợ tranh đơn / Hungarian
 *   tho.moi@thonhanh.vn   thợ vừa gửi hồ sơ, chờ admin duyệt
 *   khach@thonhanh.vn     khách hàng (SĐT 0912000001), có địa chỉ gần Hồ Gươm
 *   admin@thonhanh.vn     quản trị
 *   tho.ao01..12@thonhanh.vn  12 "thợ ảo" quanh Hồ Gươm cho script bot (npm run bots)
 *
 * Phạm vi nền tảng: CHỈ dịch vụ của thợ điện. Danh mục = các nhóm chuyên môn trong nghề điện, để tiêu chí
 * kỹ năng khi ghép cặp có ý nghĩa (số năm kinh nghiệm tính theo từng nhóm, thợ chỉ nhận đơn thuộc nhóm đã chọn).
 */
import fs from 'fs/promises';
import path from 'path';
import bcrypt from 'bcryptjs';
import { pool, sql } from '../src/config/db.js';
import { settings } from '../src/config/worker.js';
import { MEDIA_ROOT } from '../src/routes/upload.routes.js';
import { recordPaidOrder, addWalletTxn } from '../src/services/worker/finance.service.js';
import { refreshAvailability } from '../src/services/worker/state.js';
import { refreshWorkerStats } from '../src/services/matching/stats.js';
import { money } from '../src/utils/vn.js';

const PASSWORD = '12345678';
const HOAN_KIEM = [21.0285, 105.8542];
export const DEMO_APPOINTMENT_DESC = 'Lắp quạt trần phòng khách, nhà đã có sẵn móc treo và dây chờ';

// ── Tiện ích ────────────────────────────────────────────────────────────────

/** Bộ sinh số ngẫu nhiên có hạt giống (mulberry32): mỗi lần seed ra cùng một bộ dữ liệu */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    uniform: (lo, hi) => lo + next() * (hi - lo),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (arr, weights) => {
      const total = weights.reduce((s, w) => s + w, 0);
      let r = next() * total;
      for (let i = 0; i < arr.length; i++) if ((r -= weights[i]) < 0) return arr[i];
      return arr[arr.length - 1];
    },
    hex: (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('').toUpperCase(),
  };
}

const VN = 7 * 3600_000;
const MIN = 60_000;
/** Mốc thời gian (Date) của ngày VN `day` (ms 00:00 VN) lúc hh:mm */
const at = (day, minutes) => new Date(day + minutes * MIN);
const vnMidnight = (t) => {
  const v = new Date(t + VN);
  v.setUTCHours(0, 0, 0, 0);
  return v.getTime() - VN;
};
const vnWeekday = (t) => (new Date(t + VN).getUTCDay() + 6) % 7; // 0 = Thứ 2, 6 = CN
const point = (lat, lng) => `SRID=4326;POINT(${lng} ${lat})`;

/** Ngày làm việc kế tiếp lúc 9:30 (bỏ qua Chủ nhật) */
function nextWorkdayMorning(now = Date.now()) {
  let day = vnMidnight(now) + 86_400_000;
  if (vnWeekday(day) === 6) day += 86_400_000;
  return at(day, 9 * 60 + 30);
}

// ── Ảnh mẫu ─────────────────────────────────────────────────────────────────

const MEDIA_NAMES = ['id_card_front', 'id_card_back', 'portrait', 'certificate', 'job-before', 'job-after'];

async function seedMedia() {
  const src = path.join(path.dirname(new URL(import.meta.url).pathname), 'seed-assets');
  const dst = path.join(MEDIA_ROOT, 'seed');
  await fs.mkdir(dst, { recursive: true });
  for (const n of MEDIA_NAMES) await fs.copyFile(path.join(src, `${n}.png`), path.join(dst, `${n}.png`));
  const base = `${(settings.publicBaseUrl || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '')}/media/seed`;
  return Object.fromEntries(MEDIA_NAMES.map((n) => [n, `${base}/${n}.png`]));
}

// ── Danh mục, cấu hình, tài khoản ───────────────────────────────────────────

const CATEGORIES = [
  ['Sửa chữa điện', 'Mất điện, chập điện, ổ cắm, aptomat, rò điện', 1],
  ['Lắp đặt thiết bị điện', 'Đèn, quạt trần, ổ cắm và công tắc mới', 2],
  ['Đồ điện gia dụng', 'Quạt điện, bình nóng lạnh, máy bơm nước', 3],
  ['Đi dây & tủ điện', 'Đi dây mới, tủ điện, kiểm tra an toàn hệ thống điện', 4],
];

// [nhóm, tên, mô tả, giá tham chiếu, đơn vị, số ngày bảo hành]
const SERVICES = [
  ['Sửa chữa điện', 'Sửa chập điện, mất điện', 'Tìm và xử lý điểm chập, mất điện cục bộ', 250000, 'lần', 30],
  ['Sửa chữa điện', 'Sửa ổ cắm, công tắc', 'Thay, sửa ổ cắm/công tắc hỏng, chập', 150000, 'điểm', 30],
  ['Sửa chữa điện', 'Sửa cầu dao, aptomat', 'Thay aptomat, xử lý nhảy cầu dao', 200000, 'lần', 30],
  ['Sửa chữa điện', 'Chống giật, đo rò điện', 'Tìm điểm rò điện, lắp aptomat chống giật', 300000, 'lần', 30],
  ['Lắp đặt thiết bị điện', 'Lắp đặt đèn', 'Lắp đèn trần, đèn LED, đèn trang trí', 120000, 'bộ', 30],
  ['Lắp đặt thiết bị điện', 'Lắp quạt trần', 'Lắp mới / thay quạt trần, quạt trần có đèn', 300000, 'cái', 30],
  ['Lắp đặt thiết bị điện', 'Lắp thêm ổ cắm, công tắc', 'Lắp thêm ổ cắm, công tắc, kéo nhánh từ đường dây sẵn có', 180000, 'điểm', 30],
  ['Đồ điện gia dụng', 'Sửa quạt điện', 'Quạt cây, quạt treo tường quay yếu, không quay', 150000, 'cái', 30],
  ['Đồ điện gia dụng', 'Sửa bình nóng lạnh', 'Bình không nóng, nhảy aptomat, rò điện', 250000, 'bình', 60],
  ['Đồ điện gia dụng', 'Sửa máy bơm nước', 'Máy bơm không chạy, chạy không lên nước, kêu to', 250000, 'máy', 60],
  ['Đi dây & tủ điện', 'Đi dây điện mới', 'Đi lại dây điện âm/nổi tường', 300000, 'phòng', 90],
  ['Đi dây & tủ điện', 'Lắp đặt tủ điện', 'Lắp, chia lại tủ điện theo tầng / phòng', 500000, 'tủ', 90],
  ['Đi dây & tủ điện', 'Kiểm tra an toàn điện', 'Kiểm tra toàn bộ đường điện, đo cách điện', 250000, 'lần', 0],
];

async function seedCatalog(db) {
  for (const [name, desc, order] of CATEGORIES) {
    await sql(db, 'INSERT INTO service_categories (name, description, sort_order) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING', [
      name,
      desc,
      order,
    ]);
  }
  for (const [cat, name, desc, price, unit, warranty] of SERVICES) {
    await sql(
      db,
      `INSERT INTO services (category_id, name, description, base_price, unit, warranty_days)
       SELECT id, $2, $3, $4, $5, $6 FROM service_categories WHERE name = $1
       ON CONFLICT (category_id, name) DO NOTHING`,
      [cat, name, desc, price, unit, warranty],
    );
  }
}

/** Chưa có cấu hình nào đang bật -> bật cấu hình "Tự động (hybrid)" (admin đổi lại được ở web quản trị) */
async function ensureMatchingConfig(db) {
  const { rows } = await sql(db, 'SELECT id FROM matching_configs WHERE is_active');
  if (rows.length) return false;
  await sql(
    db,
    `INSERT INTO matching_configs (name, w_distance, w_trust, w_skill, w_acceptance, w_workload, max_radius_km,
                                   offer_timeout_seconds, batch_window_seconds, mode, max_offers, is_active)
     VALUES ('Tự động (hybrid)', 0.35, 0.30, 0.15, 0.10, 0.10, 10, 60, 10, 'auto', 1, TRUE)`,
  );
  return true;
}

let HASH;
async function ensureUser(db, { email, phone, name, role }) {
  HASH ??= await bcrypt.hash(PASSWORD, 10);
  const { rows } = await sql(db, 'SELECT id FROM users WHERE lower(email) = lower($1) OR ($2::text IS NOT NULL AND phone = $2) LIMIT 1', [
    email,
    phone,
  ]);
  if (rows[0]) return rows[0].id;
  const { rows: ins } = await sql(
    db,
    'INSERT INTO users (email, phone, password_hash, full_name, role) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [email, phone, HASH, name, role],
  );
  return ins[0].id;
}

async function ensureWorker(db, media, w) {
  const id = await ensureUser(db, { ...w, role: 'worker' });
  await sql(db, 'INSERT INTO workers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  const { rows } = await sql(db, 'SELECT COUNT(*)::int AS n FROM worker_documents WHERE worker_id = $1', [id]);
  if (rows[0].n) return id; // đã seed rồi
  const status = w.approved ? 'approved' : 'pending';
  await sql(
    db,
    `UPDATE workers SET bio = $2, experience_years = $3, service_radius_km = $4, trust_score = $5,
       verification_status = $6::verification_status,
       verified_at = CASE WHEN $6::verification_status = 'approved' THEN NOW() END, submitted_at = NOW(),
       current_location = $7::geography, location_updated_at = NOW(), is_online = FALSE, is_busy = FALSE
     WHERE user_id = $1`,
    [id, w.bio, w.exp, w.radius ?? 10, w.trust, status, point(w.lat, w.lng)],
  );
  for (const t of ['id_card_front', 'id_card_back', 'portrait', 'certificate']) {
    await sql(
      db,
      `INSERT INTO worker_documents (worker_id, doc_type, file_url, status, reviewed_at)
       VALUES ($1, $2, $3, $4::verification_status, CASE WHEN $4::verification_status = 'approved' THEN NOW() END)`,
      [id, t, media[t], status],
    );
  }
  for (const [cat, years] of w.skills) {
    await sql(
      db,
      `INSERT INTO worker_skills (worker_id, category_id, years) SELECT $1, id, $3 FROM service_categories WHERE name = $2
       ON CONFLICT DO NOTHING`,
      [id, cat, years],
    );
  }
  if (w.approved) {
    await sql(
      db,
      `INSERT INTO worker_bank_accounts (worker_id, bank_name, account_number, account_holder) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [id, w.bank ?? 'Vietcombank', `00110045670${w.phone.slice(-2)}`, w.name.toUpperCase()],
    );
  }
  return id;
}

const randomAround = (r, [lat, lng], maxKm) => {
  const d = maxKm * Math.sqrt(r.next());
  const b = r.uniform(0, 2 * Math.PI);
  return [lat + (d / 111.32) * Math.cos(b), lng + (d / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(b)];
};

// ── Lịch sử làm việc cho thợ demo ───────────────────────────────────────────

const STREETS = [
  ['Hàng Bài', 'Hoàn Kiếm', 21.0245, 105.852], ['Tràng Tiền', 'Hoàn Kiếm', 21.0247, 105.8556],
  ['Hàng Gai', 'Hoàn Kiếm', 21.0315, 105.85], ['Hàng Bông', 'Hoàn Kiếm', 21.03, 105.8465],
  ['Hàng Bạc', 'Hoàn Kiếm', 21.034, 105.853], ['Lương Văn Can', 'Hoàn Kiếm', 21.033, 105.8505],
  ['Phan Chu Trinh', 'Hoàn Kiếm', 21.0215, 105.856], ['Lý Thường Kiệt', 'Hoàn Kiếm', 21.024, 105.847],
  ['Trần Hưng Đạo', 'Hoàn Kiếm', 21.0205, 105.848], ['Bà Triệu', 'Hai Bà Trưng', 21.0185, 105.849],
  ['Huế', 'Hai Bà Trưng', 21.013, 105.851], ['Lò Đúc', 'Hai Bà Trưng', 21.0135, 105.859],
  ['Trần Khát Chân', 'Hai Bà Trưng', 21.008, 105.858], ['Bạch Mai', 'Hai Bà Trưng', 21.004, 105.85],
  ['Nguyễn Du', 'Hai Bà Trưng', 21.017, 105.848], ['Lê Duẩn', 'Đống Đa', 21.018, 105.841],
  ['Khâm Thiên', 'Đống Đa', 21.0175, 105.837], ['Xã Đàn', 'Đống Đa', 21.013, 105.833],
  ['Nguyễn Thái Học', 'Ba Đình', 21.0285, 105.838], ['Phan Đình Phùng', 'Ba Đình', 21.04, 105.843],
  ['Quán Thánh', 'Ba Đình', 21.041, 105.84], ['Đội Cấn', 'Ba Đình', 21.036, 105.827],
  ['Kim Mã', 'Ba Đình', 21.0315, 105.823], ['Giảng Võ', 'Ba Đình', 21.0265, 105.824],
  ['Yên Phụ', 'Tây Hồ', 21.048, 105.844], ['Thụy Khuê', 'Tây Hồ', 21.044, 105.823],
];

export const DESCRIPTIONS = {
  'Sửa chập điện, mất điện': ['Nhà mất điện cả tầng 2, tầng 1 vẫn có điện', 'Bật bình nóng lạnh là nhảy aptomat tổng', 'Ổ điện bếp có mùi khét rồi mất điện'],
  'Sửa ổ cắm, công tắc': ['Ổ cắm phòng khách lỏng, cắm vào chập chờn', 'Công tắc đèn cầu thang không ăn'],
  'Sửa quạt điện': ['Quạt cây quay yếu, có tiếng kêu', 'Quạt treo tường không quay, đèn vẫn sáng'],
  'Lắp đặt đèn': ['Lắp 6 đèn LED âm trần phòng khách', 'Thay đèn tuýp bằng đèn LED bán nguyệt'],
  'Lắp quạt trần': ['Lắp quạt trần 5 cánh phòng ngủ, đã có móc treo', 'Tháo quạt cũ, lắp quạt trần có đèn'],
  'Đi dây điện mới': ['Đi thêm đường dây cho điều hoà phòng ngủ', 'Kéo dây ra ban công lắp đèn'],
  'Sửa cầu dao, aptomat': ['Aptomat tổng hay nhảy, muốn thay loại tốt hơn', 'Thay cầu dao cũ bằng aptomat'],
  'Lắp đặt tủ điện': ['Lắp tủ điện 8 đường cho nhà 3 tầng', 'Chia lại tủ điện theo từng tầng'],
  'Kiểm tra an toàn điện': ['Nhà cũ 20 năm, muốn kiểm tra toàn bộ đường điện', 'Kiểm tra điện trước khi cho thuê nhà'],
  'Chống giật, đo rò điện': ['Chạm vào máy giặt bị tê tay', 'Vòi sen có cảm giác điện giật nhẹ'],
  'Lắp thêm ổ cắm, công tắc': ['Lắp thêm 2 ổ cắm cạnh giường ngủ', 'Thêm công tắc 2 chiều cho đèn cầu thang'],
  'Sửa bình nóng lạnh': ['Bình nóng lạnh không nóng, đèn vẫn sáng', 'Bật bình nóng lạnh là nhảy aptomat'],
  'Sửa máy bơm nước': ['Máy bơm chạy nhưng không lên nước', 'Máy bơm kêu to rồi tự tắt'],
};
const SERVICE_WEIGHTS = {
  'Sửa chập điện, mất điện': 9, 'Sửa ổ cắm, công tắc': 8, 'Sửa quạt điện': 5, 'Lắp đặt đèn': 7, 'Lắp quạt trần': 4,
  'Đi dây điện mới': 3, 'Sửa cầu dao, aptomat': 8, 'Lắp đặt tủ điện': 1, 'Kiểm tra an toàn điện': 3, 'Chống giật, đo rò điện': 3,
  'Lắp thêm ổ cắm, công tắc': 4, 'Sửa bình nóng lạnh': 4, 'Sửa máy bơm nước': 2,
};
const QUOTES = [
  ['Aptomat 2 cực 32A Panasonic', 180000], ['Dây điện Cadivi 2.5mm² (10m)', 120000], ['Ổ cắm đôi 3 chấu Panasonic', 85000],
  ['Công tắc 2 chiều', 60000], ['Tụ quạt 2.5µF', 50000], ['Đèn LED âm trần 9W (2 bộ)', 190000],
  ['Aptomat chống giật RCBO 20A', 380000], ['Ống luồn dây 20mm (5 cây)', 110000], ['Công đục tường đi dây âm (2m)', 200000],
];
const REVIEWS = {
  5: [
    'Thợ đến đúng giờ, làm nhanh và sạch sẽ.', 'Anh tư vấn kỹ, báo giá rõ ràng trước khi làm.',
    'Sửa xong còn kiểm tra lại các ổ cắm khác giúp nhà mình, rất có tâm.', 'Gọi buổi tối mà vẫn có thợ tới ngay, quá ổn.',
    'Làm gọn gàng, dọn dẹp sạch sau khi sửa.', 'Giá hợp lý, lần sau sẽ gọi lại.',
    'Giải thích rõ nguyên nhân chập điện, dặn cách dùng an toàn.', 'Đi dây gọn, đẹp, không đục phá nhiều.',
    'Lắp quạt chắc chắn, chạy êm.', null, null,
  ],
  4: ['Làm ổn nhưng đến muộn khoảng 15 phút.', 'Sửa được, giá hơi cao hơn mình nghĩ một chút.', 'Thợ làm tốt, chỉ phải chờ đi mua thêm vật tư.', null],
  3: ['Lần đầu sửa chưa hết, thợ phải quay lại kiểm tra.', 'Tạm được.'],
};

function address(r, near, maxKm) {
  const close = STREETS.filter((s) => Math.abs(s[2] - near[0]) * 111 + Math.abs(s[3] - near[1]) * 104 <= maxKm * 1.4);
  const [street, district, lat, lng] = r.pick(close.length ? close : STREETS);
  return [`Số ${r.int(2, 160)} ${street}, ${district}, Hà Nội`, lat + r.uniform(-0.0015, 0.0015), lng + r.uniform(-0.0015, 0.0015)];
}

async function insertOrder(db, o) {
  const { rows } = await sql(
    db,
    `WITH nid AS (SELECT nextval(pg_get_serial_sequence('orders', 'id')) AS id)
     INSERT INTO orders (id, code, customer_id, worker_id, service_id, address_text, location, description, scheduled_at,
                         status, matching_mode, estimated_price, extra_amount, final_price, accepted_at, started_at,
                         completed_at, warranty_until, safety_checked_at, created_at, updated_at)
     SELECT nid.id, 'TN' || to_char($15::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYMMDD') || lpad(nid.id::text, 6, '0'),
            $1, $2, $3, $4, $5::geography, $6, $7, $8, 'instant', $9, $10, $11, $12, $13, $14,
            CASE WHEN $16::int > 0 AND $14::timestamptz IS NOT NULL THEN $14::timestamptz + make_interval(days => $16) END,
            $13, $15, COALESCE($14, $15)
     FROM nid RETURNING id, code`,
    [
      o.customer_id, o.worker_id, o.service_id, o.address, point(o.lat, o.lng), o.description, o.scheduled_at, o.status,
      o.estimated, o.extra ?? 0, o.final ?? null, o.accepted_at, o.started_at ?? null, o.completed_at ?? null, o.created_at,
      o.warranty_days ?? 0,
    ],
  );
  return rows[0];
}

const addHist = (db, orderId, from, to, by, when, note = null) =>
  sql(db, 'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
    orderId, from, to, by, note, when,
  ]);

async function seedHistory(db, media, workerId, { days, perDay, seed, todayJobs }) {
  const { rows: done } = await sql(db, "SELECT 1 FROM orders WHERE worker_id = $1 AND status = 'completed' LIMIT 1", [workerId]);
  if (done.length) return 0;
  const r = rng(seed);
  const now = Date.now();
  const { rows: wrows } = await sql(
    db,
    'SELECT ST_Y(current_location::geometry) AS lat, ST_X(current_location::geometry) AS lng FROM workers WHERE user_id = $1',
    [workerId],
  );
  const base = [wrows[0].lat ?? HOAN_KIEM[0], wrows[0].lng ?? HOAN_KIEM[1]];
  const { rows: svcs } = await sql(
    db,
    `SELECT s.id, s.name, s.base_price, s.unit, s.warranty_days FROM services s
     JOIN worker_skills ws ON ws.category_id = s.category_id AND ws.worker_id = $1 WHERE s.is_active`,
    [workerId],
  );
  const { rows: customers } = await sql(db, "SELECT id FROM users WHERE role = 'customer' AND status = 'active' ORDER BY id");
  if (!svcs.length || !customers.length) return 0;
  const weights = svcs.map((s) => SERVICE_WEIGHTS[s.name] ?? 1);
  const { rows: otherRows } = await sql(
    db,
    "SELECT id FROM orders WHERE worker_id IS NOT NULL AND worker_id <> $1 AND created_at >= NOW() - make_interval(days => $2) ORDER BY id",
    [workerId, days],
  );
  const others = otherRows.map((x) => x.id).sort(() => r.next() - 0.5);
  const { rows: bankRows } = await sql(db, 'SELECT bank_name, account_number, account_holder FROM worker_bank_accounts WHERE worker_id = $1', [workerId]);
  const bank = bankRows[0];
  const completed = [];

  const today = vnMidnight(now);
  for (let i = days; i >= 0; i--) {
    const day = today - i * 86_400_000;
    const isToday = i === 0;
    if (vnWeekday(day) === 6 && !isToday) {
      // Chủ nhật nghỉ: rút tiền về ngân hàng (ví dương) hoặc nạp bù (ví âm vì hoa hồng đơn tiền mặt)
      const { rows: b } = await sql(db, 'SELECT wallet_balance FROM workers WHERE user_id = $1', [workerId]);
      const balance = b[0].wallet_balance;
      if (bank && balance >= 600_000) {
        const amount = Math.floor((balance - 200_000) / 50_000) * 50_000;
        const when = at(day, 20 * 60 + r.int(0, 50));
        const { rows: wd } = await sql(
          db,
          `INSERT INTO worker_withdrawals (worker_id, amount, bank_name, account_number, account_holder, status, transaction_code, created_at, processed_at)
           VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $7) RETURNING id`,
          [workerId, amount, bank.bank_name, bank.account_number, bank.account_holder, `SANDBOX-WD-${r.hex(10)}`, when],
        );
        await addWalletTxn(db, { workerId, type: 'withdraw', amount: -amount, withdrawalId: wd[0].id, note: `Rút tiền về ${bank.bank_name} ****${bank.account_number.slice(-4)}`, at: when });
      } else if (balance < -250_000) {
        await addWalletTxn(db, { workerId, type: 'topup', amount: 300_000, note: 'Nạp tiền vào ví qua MoMo (sandbox)', at: at(day, 19 * 60 + r.int(0, 50)) });
      }
      continue;
    }

    const n = isToday ? todayJobs : r.pick(perDay);
    let starts = [];
    if (isToday) {
      const latest = Math.floor((now - day) / MIN) - 150;
      starts = [latest - 170, latest].filter((m) => m >= 7 * 60 + 30).slice(0, n);
    } else {
      const slots = Array.from({ length: Math.floor((20 * 60 - 8 * 60) / 100) }, (_, k) => 8 * 60 + k * 100);
      starts = slots.sort(() => r.next() - 0.5).slice(0, n).sort((a, b) => a - b);
    }
    for (const m of starts) {
      const start = day + m * MIN;
      const svc = r.weighted(svcs, weights);
      const [addr, lat, lng] = address(r, base, 3.5);
      const customer = r.pick(customers).id;
      const scheduled = r.next() < 0.18;
      const created = start - (scheduled ? r.int(5, 30) * 3600_000 : r.int(12, 35) * MIN);
      const accepted = created + r.int(20, 75) * 1000;
      const onWay = scheduled ? start - r.int(15, 30) * MIN : accepted + r.int(2, 6) * MIN;
      const arrived = onWay + r.int(8, 24) * MIN;
      const working = arrived + r.int(3, 10) * MIN;
      const finished = working + r.int(25, 95) * MIN;
      if (finished >= now) continue;
      const qty = ['lần', 'tủ'].includes(svc.unit) ? 1 : r.pick([1, 1, 2, 3]);
      const estimated = svc.base_price * qty;
      let extra = 0;
      let quote = null;
      if (r.next() < 0.3) {
        quote = r.pick(QUOTES);
        extra = quote[1];
      }
      const o = await insertOrder(db, {
        customer_id: customer, worker_id: workerId, service_id: svc.id, address: addr, lat, lng,
        description: r.pick(DESCRIPTIONS[svc.name] ?? ['Cần thợ kiểm tra']), scheduled_at: scheduled ? new Date(start) : null,
        status: 'completed', estimated, extra, final: estimated + extra, accepted_at: new Date(accepted),
        started_at: new Date(working), completed_at: new Date(finished), created_at: new Date(created), warranty_days: svc.warranty_days,
      });
      await sql(
        db,
        `INSERT INTO order_offers (order_id, worker_id, mode, score, distance_km, rank_position, round, status, offered_at, expires_at, responded_at)
         VALUES ($1, $2, 'instant', $3, $4, 1, 1, 'accepted', $5, $6, $7)`,
        [o.id, workerId, r.uniform(0.72, 0.95).toFixed(5), r.uniform(0.4, 3.2).toFixed(3), new Date(created), new Date(created + 60_000), new Date(accepted)],
      );
      const steps = [
        [null, 'pending', created, customer, 'Khách tạo đơn'], ['pending', 'matching', created, customer, 'Bắt đầu tìm thợ'],
        ['matching', 'accepted', accepted, workerId, 'Thợ nhận đơn'], ['accepted', 'on_the_way', onWay, workerId],
        ['on_the_way', 'arrived', arrived, workerId], ['arrived', 'in_progress', working, workerId], ['in_progress', 'completed', finished, workerId],
      ];
      for (const [from, to, when, by, note] of steps) await addHist(db, o.id, from, to, by, new Date(when), note ?? null);
      if (quote) {
        await sql(
          db,
          `INSERT INTO order_extra_quotes (order_id, worker_id, description, amount, status, created_at, responded_at)
           VALUES ($1, $2, $3, $4, 'approved', $5, $6)`,
          [o.id, workerId, quote[0], quote[1], new Date(working + 8 * MIN), new Date(working + 10 * MIN)],
        );
      }
      const method = r.weighted(['cash', 'momo', 'vnpay'], [55, 30, 15]);
      const paidAt = new Date(finished + r.int(2, 9) * MIN);
      await sql(
        db,
        `INSERT INTO payments (order_id, method, amount, status, provider_txn_id, created_at, paid_at)
         VALUES ($1, $2, $3, 'success', $4, $5, $6)`,
        [o.id, method, estimated + extra, method === 'cash' ? null : `SANDBOX-${method.toUpperCase()}-${r.hex(10)}`, new Date(finished + 2 * MIN), paidAt],
      );
      await recordPaidOrder(db, o.id); // đúng hàm nghiệp vụ hệ thống dùng khi khách thanh toán
      if (now - finished <= 10 * 86_400_000) {
        await sql(db, "INSERT INTO order_photos (order_id, uploader_id, kind, url, created_at) VALUES ($1,$2,'before',$3,$4), ($1,$2,'after',$5,$6)", [
          o.id, workerId, media['job-before'], new Date(working), media['job-after'], new Date(finished),
        ]);
      }
      if (r.next() < 0.86) {
        const rating = r.weighted([5, 4, 3], [80, 17, 3]);
        const when = new Date(Math.min(finished + r.int(20, 900) * MIN, now - 5 * MIN));
        await sql(db, 'INSERT INTO reviews (order_id, customer_id, worker_id, rating, comment, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
          o.id, customer, workerId, rating, r.pick(REVIEWS[rating]), when,
        ]);
      }
      completed.push({ ...o, finished, total: estimated + extra });
    }

    // Vài lời mời đã bỏ qua / hết giờ trong ngày (tỷ lệ nhận đơn giống thật)
    for (let k = r.pick([0, 0, 0, 1]); k > 0 && others.length; k--) {
      const oid = others.pop();
      const t = day + (r.int(8, 20) * 60 + r.int(0, 59)) * MIN;
      if (t >= now) continue;
      const status = r.pick(['rejected', 'expired']);
      await sql(
        db,
        `INSERT INTO order_offers (order_id, worker_id, mode, score, distance_km, rank_position, round, status, offered_at, expires_at, responded_at, reason)
         VALUES ($1, $2, 'instant', $3, $4, 2, 1, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [
          oid, workerId, r.uniform(0.6, 0.85).toFixed(5), r.uniform(1, 4.5).toFixed(3), status, new Date(t), new Date(t + 60_000),
          new Date(status === 'expired' ? t + 60_000 : t + 25_000), status === 'rejected' ? r.pick(['Đang bận việc khác', 'Quá xa', null]) : null,
        ],
      );
    }
  }

  // Lịch hẹn sắp tới: 9:30 sáng ngày làm việc kế tiếp
  const start = nextWorkdayMorning(now);
  const { rows: fanRows } = await sql(db, "SELECT id, name, base_price, warranty_days FROM services WHERE name = 'Lắp quạt trần' LIMIT 1");
  const fan = fanRows[0] ?? svcs[0];
  const [addr, lat, lng] = address(r, base, 2.5);
  const createdUp = now - 3 * 3600_000;
  const up = await insertOrder(db, {
    customer_id: r.pick(customers).id, worker_id: workerId, service_id: fan.id, address: addr, lat, lng, description: DEMO_APPOINTMENT_DESC,
    scheduled_at: start, status: 'accepted', estimated: fan.base_price, accepted_at: new Date(createdUp + 40_000), created_at: new Date(createdUp),
  });
  await sql(
    db,
    `INSERT INTO order_offers (order_id, worker_id, mode, score, distance_km, rank_position, round, status, offered_at, expires_at, responded_at)
     VALUES ($1, $2, 'instant', 0.88123, 1.64, 1, 1, 'accepted', $3, $4, $5)`,
    [up.id, workerId, new Date(createdUp), new Date(createdUp + 60_000), new Date(createdUp + 40_000)],
  );
  await addHist(db, up.id, null, 'pending', null, new Date(createdUp), 'Khách tạo đơn');
  await addHist(db, up.id, 'pending', 'matching', null, new Date(createdUp), 'Bắt đầu tìm thợ');
  await addHist(db, up.id, 'matching', 'accepted', workerId, new Date(createdUp + 40_000), 'Thợ nhận đơn');

  // Chỉ số của thợ: số đơn, điểm đánh giá trung bình (trust score do module của thành viên A tính)
  await sql(
    db,
    `UPDATE workers w SET total_jobs = s.jobs, rating_count = s.cnt, rating_avg = COALESCE(ROUND(s.avg, 2), 0)
     FROM (SELECT (SELECT COUNT(*) FROM orders WHERE worker_id = $1 AND status = 'completed') AS jobs,
                  COUNT(*) AS cnt, AVG(rating) AS avg FROM reviews WHERE worker_id = $1) s
     WHERE w.user_id = $1`,
    [workerId],
  );

  // Thông báo gần đây (đa phần đã đọc)
  const notes = [[`Lịch hẹn mới: ${fan.name}`, `Hẹn ${new Date(start).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })} tại ${addr}`, 'order', { order_id: up.id }, new Date(createdUp + 40_000), false]];
  for (const o of completed.slice(-4)) {
    notes.push(['Đơn đã được thanh toán', `Đơn ${o.code}: ${money(o.total)}`, 'payment', { order_id: o.id }, new Date(o.finished + 8 * MIN), true]);
  }
  const { rows: lastReview } = await sql(db, 'SELECT order_id, rating, comment, created_at FROM reviews WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 1', [workerId]);
  if (lastReview[0]) {
    const lr = lastReview[0];
    notes.push([`Bạn nhận được đánh giá ${lr.rating} sao`, lr.comment, 'review', { order_id: lr.order_id }, lr.created_at, false]);
  }
  for (const [title, body, type, data, when, read] of notes) {
    await sql(db, 'INSERT INTO notifications (user_id, title, body, type, data, is_read, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      workerId, title, body, type, data, read, when,
    ]);
  }
  return completed.length;
}

/** Lịch hẹn mẫu là "sáng mai 9:30" tính từ ngày seed; vài hôm sau sẽ quá giờ mà vẫn "đã nhận" -> thợ demo bị tính bận.
 *  Mỗi lần seed (Docker khởi động), dời các lịch mẫu đã quá giờ sang 9:30 ngày làm việc kế tiếp. */
async function refreshDemoAppointments(db) {
  const { rows } = await sql(
    db,
    `UPDATE orders SET scheduled_at = $2, updated_at = NOW()
     WHERE description = $1 AND status = 'accepted' AND scheduled_at < NOW()
     RETURNING worker_id`,
    [DEMO_APPOINTMENT_DESC, nextWorkdayMorning()],
  );
  for (const r of rows) await refreshAvailability(db, r.worker_id);
  return rows.length;
}

// ── Chạy ────────────────────────────────────────────────────────────────────

export async function seedDemo() {
  const media = await seedMedia();
  const client = await pool.connect();
  const log = [];
  try {
    await client.query('BEGIN');
    await seedCatalog(client);
    if (await ensureMatchingConfig(client)) log.push("bật cấu hình ghép 'Tự động (hybrid)'");

    await ensureUser(client, { email: 'admin@thonhanh.vn', phone: '0900000000', name: 'Quản trị viên', role: 'admin' });
    const [lat, lng] = HOAN_KIEM;
    const tho = await ensureWorker(client, media, {
      email: 'tho@thonhanh.vn', phone: '0987000001', name: 'Trần Minh Đức', approved: true, lat: lat + 0.006, lng: lng + 0.004,
      trust: 0.92, exp: 8, bio: 'Thợ điện dân dụng 8 năm, chuyên sửa chập điện, thay aptomat, lắp đèn.',
      skills: [['Sửa chữa điện', 8], ['Lắp đặt thiết bị điện', 8], ['Đồ điện gia dụng', 5]],
    });
    const tho2 = await ensureWorker(client, media, {
      email: 'tho2@thonhanh.vn', phone: '0987000002', name: 'Nguyễn Văn Bình', approved: true, lat: lat - 0.01, lng: lng + 0.008,
      trust: 0.85, exp: 5, bio: 'Lắp đặt điện nhà mới, đi dây âm tường, tủ điện.', bank: 'Techcombank',
      skills: [['Đi dây & tủ điện', 5], ['Lắp đặt thiết bị điện', 5], ['Sửa chữa điện', 3]],
    });
    await ensureWorker(client, media, {
      email: 'tho.moi@thonhanh.vn', phone: '0987000003', name: 'Lê Quang Minh', approved: false, lat: lat + 0.012, lng: lng - 0.006,
      trust: 0, exp: 2, bio: 'Thợ mới đăng ký.', skills: [['Sửa chữa điện', 2], ['Lắp đặt thiết bị điện', 1]],
    });

    // Thợ ảo cho script bot: rải trong 3 km quanh Hồ Gươm
    const r = rng(2026);
    const LAST = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi'];
    const FIRST = ['An', 'Cường', 'Dũng', 'Hải', 'Hùng', 'Khánh', 'Long', 'Nam', 'Phúc', 'Quân', 'Sơn', 'Tuấn'];
    for (let i = 1; i <= 12; i++) {
      const [blat, blng] = randomAround(r, HOAN_KIEM, 3);
      // Thợ ảo nào cũng sửa chữa điện; thêm nhóm khác theo lượt để có cả thợ chuyên / thợ đa năng
      const skills = [['Sửa chữa điện', r.int(1, 12)]];
      if (i % 2 === 0) skills.push(['Lắp đặt thiết bị điện', r.int(1, 10)]);
      if (i % 3 === 0) skills.push(['Đồ điện gia dụng', r.int(1, 8)]);
      if (i % 4 === 0) skills.push(['Đi dây & tủ điện', r.int(1, 8)]);
      await ensureWorker(client, media, {
        email: `tho.ao${String(i).padStart(2, '0')}@thonhanh.vn`, phone: `09860000${String(i).padStart(2, '0')}`,
        name: `${LAST[i % LAST.length]} Văn ${FIRST[i - 1]}`, approved: true, lat: blat, lng: blng,
        trust: Number(r.uniform(0.55, 0.95).toFixed(4)), exp: r.int(1, 12), bio: 'Thợ ảo (bot) phục vụ demo.', skills,
      });
    }

    // Khách demo + vài khách cho lịch sử đơn
    const khach = await ensureUser(client, { email: 'khach@thonhanh.vn', phone: '0912000001', name: 'Nguyễn Thu Hà', role: 'customer' });
    const { rows: addr } = await sql(client, 'SELECT 1 FROM customer_addresses WHERE customer_id = $1', [khach]);
    if (!addr.length) {
      await sql(
        client,
        `INSERT INTO customer_addresses (customer_id, label, address_text, location, is_default)
         VALUES ($1, 'Nhà', '15 Hàng Bài, Hoàn Kiếm, Hà Nội', $2::geography, TRUE)`,
        [khach, point(lat - 0.004, lng + 0.002)],
      );
    }
    const CUSTOMERS = ['Phạm Thị Lan', 'Đỗ Minh Tuấn', 'Vũ Thu Trang', 'Hoàng Văn Nam', 'Bùi Thị Mai', 'Lê Hoàng Long', 'Ngô Thị Hương',
      'Trịnh Văn Hải', 'Đặng Thu Hằng', 'Phan Văn Khánh', 'Mai Thị Ngọc', 'Tạ Quang Huy'];
    for (const [i, name] of CUSTOMERS.entries()) {
      const phone = `09120000${String(i + 2).padStart(2, '0')}`;
      await ensureUser(client, { email: `khach${String(i + 2).padStart(2, '0')}@thonhanh.vn`, phone, name, role: 'customer' });
    }

    const h1 = await seedHistory(client, media, tho, { days: 42, perDay: [2, 3, 3, 4], seed: 11, todayJobs: 2 });
    const h2 = await seedHistory(client, media, tho2, { days: 28, perDay: [1, 2, 2, 3], seed: 22, todayJobs: 1 });
    if (h1 || h2) log.push(`lịch sử demo: tho@ ${h1} đơn, tho2@ ${h2} đơn`);
    const { rows: allWorkers } = await sql(client, "SELECT user_id FROM workers");
    await refreshWorkerStats(client, allWorkers.map((w) => w.user_id));
    const moved = await refreshDemoAppointments(client);
    if (moved) log.push(`dời ${moved} lịch hẹn mẫu đã quá giờ sang sáng ngày làm việc kế tiếp`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log(`[seed:demo] Xong${log.length ? `: ${log.join('; ')}` : ''}`);
  console.log(
    '[seed:demo] Tài khoản (mật khẩu 12345678): tho@thonhanh.vn, tho2@thonhanh.vn, tho.moi@thonhanh.vn, ' +
      'khach@thonhanh.vn (SĐT 0912000001), admin@thonhanh.vn, tho.ao01..12@thonhanh.vn (bot)',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDemo()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
