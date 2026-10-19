/**
 * Khách hàng giả lập — đóng vai khách để DEMO / KIỂM THỬ app thợ khi không mở app khách.  [Thành viên B]
 * Gọi đúng API của app khách (/api/customer/...) nên đơn đi qua luồng thật: tạo đơn -> bộ điều phối -> app thợ.
 *
 *   npm run demo:customer -- order                       # đơn đặt ngay, cách thợ demo ~700 m
 *   npm run demo:customer -- order --near tho2@thonhanh.vn --dist 1500
 *   npm run demo:customer -- order --after 90            # hẹn lịch sau 90 phút
 *   npm run demo:customer -- quote <đơn>                 # duyệt báo giá phát sinh đang chờ (--reject để từ chối)
 *   npm run demo:customer -- pay <đơn> --method cash     # khách chọn tiền mặt (thợ bấm "Đã thu tiền")
 *   npm run demo:customer -- pay <đơn> --method momo     # thanh toán online sandbox -> cộng ví thợ
 *   npm run demo:customer -- review <đơn> --stars 5 --comment "Thợ làm nhanh"
 *   npm run demo:customer -- cancel <đơn>
 *   npm run demo:customer -- show <đơn>
 *   npm run demo:customer -- rush --count 12             # nhiều đơn cùng lúc (demo Hungarian / thợ ảo)
 *
 * <đơn> nhận id (12) hoặc mã đơn (TN261019000012). Docker: docker compose exec api npm run demo:customer -- order
 */
import { pool, q } from '../src/config/db.js';
import { call, login, money, offset, parseArgs } from './lib/http.js';
import { DESCRIPTIONS as BY_SERVICE } from './seed-demo.js';

const HOAN_KIEM = [21.0285, 105.8542];
const DEMO_CUSTOMER = 'khach@thonhanh.vn';
const STREETS = ['Hàng Bài', 'Tràng Tiền', 'Lý Thường Kiệt', 'Bà Triệu', 'Hàng Gai', 'Đinh Tiên Hoàng', 'Phan Chu Trinh'];
const DESCRIPTIONS = [
  'Nhà bị nhảy aptomat liên tục khi bật bình nóng lạnh',
  'Ổ cắm phòng khách có mùi khét, không dùng được',
  'Mất điện tầng 2, tầng 1 vẫn có điện',
  'Cần lắp thêm 3 bóng đèn LED âm trần phòng ngủ',
  'Quạt trần kêu to và quay yếu',
  'Công tắc cầu thang chập chờn',
];
const MODE_LABEL = { instant: 'tức thời (Greedy top-k)', batch: 'theo lô (Hungarian)', auto: 'tự động — hệ thống tự chọn' };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
/** Mô tả sự cố hợp với dịch vụ (lấy từ dữ liệu demo), không có thì mô tả chung */
const describe = (serviceName) => pick(BY_SERVICE[serviceName] ?? DESCRIPTIONS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  console.error(msg);
  process.exitCode = 1;
  throw new Error('__exit__');
}

async function findOrder(ref) {
  if (!ref) die('Thiếu mã đơn');
  const { rows } = await q(
    `SELECT o.*, u.email AS customer_email, u.phone AS customer_phone, s.name AS service_name
     FROM orders o JOIN users u ON u.id = o.customer_id JOIN services s ON s.id = o.service_id
     WHERE o.id::text = $1 OR o.code = $1`,
    [String(ref)],
  );
  if (!rows[0]) die(`Không có đơn ${ref}`);
  return rows[0];
}

const customerToken = (o) => login('customer', o.customer_email || o.customer_phone);

/** Địa chỉ riêng cho script ("Demo"): dời tới toạ độ cần đặt đơn rồi tạo đơn bằng địa chỉ đó */
async function demoAddress(token, lat, lng) {
  const list = await call('GET', '/api/customer/addresses', { token });
  const text = `Số ${1 + Math.floor(Math.random() * 120)} ${pick(STREETS)}, Hoàn Kiếm, Hà Nội`;
  const found = list.find((a) => a.label === 'Demo');
  if (found) return (await call('PATCH', `/api/customer/addresses/${found.id}`, { token, body: { address_text: text, lat, lng } })).id;
  return (await call('POST', '/api/customer/addresses', { token, body: { label: 'Demo', address_text: text, lat, lng } })).id;
}

async function cmdOrder(a) {
  const token = await login('customer', a.customer);
  let center = HOAN_KIEM;
  let serviceId = a.service ? Number(a.service) : null;
  if (a.near) {
    const { rows } = await q(
      `SELECT w.user_id, ST_Y(w.current_location::geometry) AS lat, ST_X(w.current_location::geometry) AS lng
       FROM workers w JOIN users u ON u.id = w.user_id WHERE lower(u.email) = lower($1)`,
      [a.near],
    );
    if (!rows[0]) die(`Không có thợ ${a.near} (chạy npm run seed:demo trước)`);
    if (rows[0].lat !== null) center = [rows[0].lat, rows[0].lng];
    else console.log(`! ${a.near} chưa có vị trí -> đặt quanh Hồ Gươm`);
    if (!serviceId) {
      const { rows: s } = await q(
        `SELECT s.id FROM services s JOIN worker_skills ws ON ws.category_id = s.category_id
         WHERE ws.worker_id = $1 AND s.is_active ORDER BY random() LIMIT 1`,
        [rows[0].user_id],
      );
      serviceId = s[0]?.id ?? null;
    }
  }
  if (!serviceId) serviceId = (await q('SELECT id FROM services WHERE is_active ORDER BY id LIMIT 1')).rows[0]?.id;
  const serviceName = (await q('SELECT name FROM services WHERE id = $1', [serviceId])).rows[0]?.name;
  const [lat, lng] = offset(center[0], center[1], Number(a.dist));
  const addressId = await demoAddress(token, lat, lng);
  const scheduledAt = Number(a.after) ? new Date(Date.now() + Number(a.after) * 60_000) : null;
  const order = await call('POST', '/api/customer/orders', {
    token,
    body: { service_id: serviceId, address_id: addressId, description: a.desc || describe(serviceName), ...(scheduledAt ? { scheduled_at: scheduledAt.toISOString() } : {}) },
  });
  const { rows: d } = await q('SELECT mode FROM order_dispatches WHERE order_id = $1', [order.id]);
  const mode = d[0]?.mode ?? order.matching_mode;
  console.log(
    `Đơn ${order.code} (#${order.id}) · ${order.service_name} · ${scheduledAt ? `hẹn ${scheduledAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}` : 'đặt ngay'}` +
      ` · cách tâm ~${Math.round(a.dist)} m · chế độ ghép: ${MODE_LABEL[mode] ?? mode}`,
  );
  // auto / batch: bộ điều phối (chạy trong API) gửi lời mời ở nhịp kế tiếp -> chờ tối đa vài giây để báo kết quả
  for (let i = 0; i < (mode === 'instant' ? 1 : 12); i++) {
    const { rows } = await q(
      `SELECT f.mode, u.full_name FROM order_offers f JOIN users u ON u.id = f.worker_id
       WHERE f.order_id = $1 AND f.status = 'offered' ORDER BY f.rank_position`,
      [order.id],
    );
    if (rows.length) {
      const how = rows[0].mode === 'instant' ? 'gửi ngay cho top-k (Greedy)' : 'ghép tối ưu Hungarian';
      console.log(`  Đã gửi lời mời cho: ${rows.map((r) => r.full_name).join(', ')} — ${how}`);
      return;
    }
    await sleep(1000);
  }
  console.log('  Chưa gửi lời mời (chưa có thợ phù hợp đang bật nhận đơn) — hệ thống thử lại vài giây một lần');
}

async function cmdQuote(a) {
  const o = await findOrder(a._[1]);
  const { rows } = await q("SELECT id, description, amount FROM order_extra_quotes WHERE order_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1", [o.id]);
  if (!rows[0]) die(`Đơn ${o.code} không có báo giá phát sinh nào đang chờ`);
  console.log(`  Báo giá: ${rows[0].description.replaceAll('\n', ' | ')} — ${money(rows[0].amount)}`);
  const res = await call('POST', `/api/customer/orders/${o.id}/quotes/${rows[0].id}/${a.reject ? 'reject' : 'approve'}`, { token: await customerToken(o) });
  console.log(`${a.reject ? 'Đã từ chối' : 'Đã đồng ý'} · tổng đơn mới: ${money(res.total_amount)}`);
}

async function cmdPay(a) {
  const o = await findOrder(a._[1]);
  const token = await customerToken(o);
  const p = await call('POST', `/api/customer/orders/${o.id}/payments`, { token, body: { method: a.method } });
  console.log(`  Số tiền: ${money(p.amount)} · phương thức: ${a.method}`);
  if (a.method !== 'cash') {
    await call('POST', `/api/customer/payments/${p.id}/sandbox-confirm`, { token });
    console.log('  (sandbox) Thanh toán thành công -> đã cộng tiền thực nhận vào ví thợ');
  } else {
    console.log('  Thợ sẽ thấy "Khách chọn trả tiền mặt" và nút "Đã thu tiền mặt" trong chi tiết đơn');
  }
}

async function cmdReview(a) {
  const o = await findOrder(a._[1]);
  await call('POST', `/api/customer/orders/${o.id}/review`, { token: await customerToken(o), body: { rating: Number(a.stars), comment: a.comment } });
  console.log(`Đã đánh giá ${a.stars} sao cho đơn ${o.code}`);
}

async function cmdCancel(a) {
  const o = await findOrder(a._[1]);
  await call('POST', `/api/customer/orders/${o.id}/cancel`, { token: await customerToken(o), body: { reason: a.reason } });
  console.log(`Đã huỷ đơn ${o.code}`);
}

async function cmdShow(a) {
  const o = await findOrder(a._[1]);
  const { rows: w } = await q('SELECT full_name FROM users WHERE id = $1', [o.worker_id]);
  console.log(`Đơn ${o.code} (#${o.id}) · ${o.service_name} · trạng thái: ${o.status} · chế độ ghép: ${o.matching_mode}`);
  console.log(`  Địa chỉ: ${o.address_text}`);
  console.log(`  Thợ: ${w[0]?.full_name ?? '—'} · giá dự kiến ${money(o.estimated_price)} · phát sinh ${money(o.extra_amount)} · chốt ${o.final_price ? money(o.final_price) : '—'}`);
  const { rows: offers } = await q(
    'SELECT f.id, f.status, f.round, f.mode, f.score, f.reason, u.full_name FROM order_offers f JOIN users u ON u.id = f.worker_id WHERE f.order_id = $1 ORDER BY f.id',
    [o.id],
  );
  for (const f of offers) console.log(`  offer #${f.id} -> ${f.full_name}: ${f.status}${f.reason ? ` (${f.reason})` : ''} · đợt ${f.round} · ${f.mode} · điểm ${Number(f.score).toFixed(3)}`);
  const { rows: quotes } = await q('SELECT id, description, amount, status FROM order_extra_quotes WHERE order_id = $1 ORDER BY id', [o.id]);
  for (const x of quotes) console.log(`  báo giá #${x.id}: ${x.description.replaceAll('\n', ' | ')} ${money(x.amount)} — ${x.status}`);
  const { rows: pays } = await q('SELECT id, method, amount, status FROM payments WHERE order_id = $1 ORDER BY id', [o.id]);
  for (const p of pays) console.log(`  thanh toán #${p.id}: ${p.method} ${money(p.amount)} — ${p.status}`);
}

async function cmdRush(a) {
  const { rows: customers } = await q("SELECT id, email, phone, full_name FROM users WHERE role = 'customer' AND status = 'active' AND password_hash IS NOT NULL ORDER BY id LIMIT 40");
  const { rows: services } = await q(
    "SELECT s.id, s.name FROM services s JOIN service_categories c ON c.id = s.category_id WHERE s.is_active AND c.name = COALESCE($1, c.name)",
    [a.category ?? null],
  );
  if (!customers.length || !services.length) die('Thiếu khách hàng / dịch vụ (chạy npm run seed:demo trước)');
  let made = 0;
  for (let i = 0; i < Number(a.count); i++) {
    const c = customers[i % customers.length];
    try {
      const token = await login('customer', c.email || c.phone);
      const [lat, lng] = offset(Number(a.lat), Number(a.lng), 200 + Math.random() * (Number(a.radius) * 1000 - 200));
      const addressId = await demoAddress(token, lat, lng);
      const svc = pick(services);
      const o = await call('POST', '/api/customer/orders', { token, body: { service_id: svc.id, address_id: addressId, description: describe(svc.name) } });
      made++;
      console.log(`  ${o.code} của ${c.full_name}`);
    } catch (err) {
      console.log(`  bỏ qua (${c.full_name}): ${err.message}`);
    }
  }
  console.log(`Đã tạo ${made} đơn quanh (${a.lat}, ${a.lng}), bán kính ${a.radius} km`);
}

const COMMANDS = { order: cmdOrder, quote: cmdQuote, pay: cmdPay, review: cmdReview, cancel: cmdCancel, show: cmdShow, rush: cmdRush };

const args = parseArgs(process.argv.slice(2), {
  near: 'tho@thonhanh.vn', dist: 700, after: 0, customer: DEMO_CUSTOMER, method: 'cash', stars: 5,
  comment: 'Thợ đến đúng giờ, làm cẩn thận, giá hợp lý.', reason: 'Đổi kế hoạch', count: 10,
  lat: HOAN_KIEM[0], lng: HOAN_KIEM[1], radius: 3,
});
if (args.near === true || args.near === '') args.near = null;
const cmd = COMMANDS[args._[0]];
try {
  if (!cmd) die(`Lệnh: ${Object.keys(COMMANDS).join(' | ')}  (xem hướng dẫn đầu file scripts/demo-customer.js)`);
  if (Number(args.after) && Number(args.after) < 30) die('--after phải >= 30 phút');
  await cmd(args);
} catch (err) {
  if (err.message !== '__exit__') {
    console.error(`Lỗi: ${err.message}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
