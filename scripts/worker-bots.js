/**
 * Thợ ảo (bot) — giả lập nhiều thợ dùng app để DEMO / KIỂM THỬ khi không đủ điện thoại.  [Thành viên B]
 *
 * Mỗi bot đăng nhập và gọi đúng API của app thợ, nên đơn đi qua luồng thật và app khách thấy realtime:
 * nhận offer -> nhận / từ chối -> di chuyển tới khách (gửi vị trí dần dần) -> đến nơi -> chụp ảnh ->
 * xác nhận an toàn -> sửa -> hoàn thành (chờ khách thanh toán qua app).
 *
 *   npm run bots                       # 8 bot quanh Hồ Gươm
 *   npm run bots -- --count 12 --accept 0.7 --speed 300 --tick 2
 *   docker compose exec api npm run bots
 *
 * Chỉ dùng các tài khoản thợ ảo tho.ao01..12@thonhanh.vn (tạo bởi npm run seed:demo). Ctrl+C để dừng (bot tắt nhận đơn).
 */
import { API, call, km, login, parseArgs } from './lib/http.js';

const HOAN_KIEM = [21.0285, 105.8542];
const a = parseArgs(process.argv.slice(2), { count: 8, accept: 0.85, speed: 250, tick: 2, lat: HOAN_KIEM[0], lng: HOAN_KIEM[1], radius: 3 });
// Ảnh mẫu do seed chép vào /media/seed; ghi theo địa chỉ công khai (app tự đổi localhost sang IP máy chủ đang dùng)
const PUBLIC = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.API_PORT || 3000}`).replace(/\/+$/, '');
const PHOTO = (kind) => `${PUBLIC}/media/seed/job-${kind}.png`;
let stop = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (bot, msg) => console.log(`  [${bot.name}] ${msg}`);

function randomAround([lat, lng], radiusKm) {
  const d = radiusKm * Math.sqrt(Math.random());
  const b = Math.random() * 2 * Math.PI;
  return [lat + (d / 111.32) * Math.cos(b), lng + (d / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(b)];
}

async function startBot(i) {
  const email = `tho.ao${String(i).padStart(2, '0')}@thonhanh.vn`;
  const token = await login('worker', email);
  const me = await call('GET', '/api/worker/me', { token });
  const loc = me.profile.location;
  const pos =
    loc && km(loc.latitude, loc.longitude, a.lat, a.lng) <= Number(a.radius) ? [loc.latitude, loc.longitude] : randomAround([Number(a.lat), Number(a.lng)], Number(a.radius));
  const bot = { email, token, name: me.user.full_name, pos, decideAt: new Map(), lastStep: new Map() };
  await call('PATCH', '/api/worker/availability', { token, body: { online: true, latitude: pos[0], longitude: pos[1] } });
  return bot;
}

async function moveTo(bot, lat, lng) {
  bot.pos = [lat, lng];
  await call('PATCH', '/api/worker/location', { token: bot.token, body: { latitude: lat, longitude: lng } });
}

async function handleOffer(bot) {
  const offer = await call('GET', '/api/worker/offers/current', { token: bot.token });
  if (!offer) return;
  // mỗi offer "suy nghĩ" 3-10 giây như người thật
  if (!bot.decideAt.has(offer.id)) bot.decideAt.set(offer.id, Date.now() + (3 + (offer.id * 7) % 8) * 1000);
  if (Date.now() < bot.decideAt.get(offer.id)) return;
  bot.decideAt.delete(offer.id);
  try {
    if (Math.random() < Number(a.accept)) {
      await call('POST', `/api/worker/offers/${offer.id}/accept`, { token: bot.token });
      log(bot, `NHẬN đơn ${offer.code} (${offer.mode}, điểm ${Number(offer.match_score).toFixed(2)}, ${offer.distance_km} km)`);
    } else {
      await call('POST', `/api/worker/offers/${offer.id}/reject`, { token: bot.token, body: { reason: Math.random() < 0.5 ? 'Đang bận việc khác' : 'Quá xa' } });
      log(bot, `từ chối đơn ${offer.code}`);
    }
  } catch (err) {
    log(bot, `bỏ qua đơn ${offer.code}: ${err.message}`);
  }
}

async function progressJobs(bot) {
  const { items } = await call('GET', '/api/worker/orders?group=active', { token: bot.token });
  const done = await call('GET', '/api/worker/orders?group=completed&pageSize=5', { token: bot.token });
  for (const job of [...items, ...done.items.filter((x) => !x.paid)]) {
    const since = Date.now() - (bot.lastStep.get(job.id) ?? 0);
    const step = async (status, extra = {}) => {
      await call('POST', `/api/worker/orders/${job.id}/status`, { token: bot.token, body: { status, ...extra } });
      bot.lastStep.set(job.id, Date.now());
    };
    try {
      if (job.status === 'accepted' && since > 4000) {
        if (job.scheduled_at && new Date(job.scheduled_at).getTime() - Date.now() > 30 * 60_000) continue;
        await step('on_the_way');
        log(bot, `bắt đầu đi tới đơn ${job.code}`);
      } else if (job.status === 'on_the_way') {
        const d = km(bot.pos[0], bot.pos[1], job.latitude, job.longitude) * 1000;
        if (d <= Number(a.speed)) {
          await moveTo(bot, job.latitude, job.longitude);
          await step('arrived');
          log(bot, `đã đến đơn ${job.code}`);
        } else {
          const f = Number(a.speed) / d;
          await moveTo(bot, bot.pos[0] + (job.latitude - bot.pos[0]) * f, bot.pos[1] + (job.longitude - bot.pos[1]) * f);
        }
      } else if (job.status === 'arrived' && since > 8000) {
        await call('POST', `/api/worker/orders/${job.id}/photos`, { token: bot.token, body: { kind: 'before', urls: [PHOTO('before')] } }).catch(() => {});
        await step('in_progress', { safety_confirmed: true });
      } else if (job.status === 'in_progress' && since > 15000) {
        const detail = await call('GET', `/api/worker/orders/${job.id}`, { token: bot.token });
        if (detail.has_pending_quote) continue; // chờ khách duyệt báo giá
        if (detail.needs_after_photo) await call('POST', `/api/worker/orders/${job.id}/photos`, { token: bot.token, body: { kind: 'after', urls: [PHOTO('after')] } });
        await step('completed');
        log(bot, `HOÀN THÀNH đơn ${job.code} (chờ khách thanh toán qua app)`);
      }
    } catch (err) {
      log(bot, `đơn ${job.code}: ${err.message}`);
    }
  }
}

process.on('SIGINT', () => (stop = true));
process.on('SIGTERM', () => (stop = true));

const bots = [];
for (let i = 1; i <= Math.min(12, Number(a.count)); i++) {
  try {
    bots.push(await startBot(i));
  } catch (err) {
    console.log(`  bỏ qua thợ ảo ${i}: ${err.message}`);
  }
}
if (!bots.length) {
  console.log('Không bật được thợ ảo nào (chạy npm run seed:demo và bật API trước)');
  process.exit(1);
}
console.log(`Đã bật ${bots.length} thợ ảo quanh (${a.lat}, ${a.lng}) — API ${API}. Ctrl+C để dừng.`);

let lastBeat = Date.now();
while (!stop) {
  const beat = Date.now() - lastBeat > 30_000; // giữ vị trí "còn mới" (bộ điều phối bỏ qua thợ mất GPS quá 10 phút)
  for (const bot of bots) {
    try {
      if (beat) await moveTo(bot, bot.pos[0] + (Math.random() - 0.5) * 0.0006, bot.pos[1] + (Math.random() - 0.5) * 0.0006);
      await handleOffer(bot);
      await progressJobs(bot);
    } catch (err) {
      log(bot, err.message);
    }
  }
  if (beat) lastBeat = Date.now();
  await sleep(Number(a.tick) * 1000);
}

for (const bot of bots) await call('PATCH', '/api/worker/availability', { token: bot.token, body: { online: false } }).catch(() => {});
console.log('Đã tắt thợ ảo.');
