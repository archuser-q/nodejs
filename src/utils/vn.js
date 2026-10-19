/** Tiện ích hiển thị theo giờ / tiền Việt Nam (dùng trong nội dung thông báo) */

const TZ = 'Asia/Ho_Chi_Minh';
const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Các thành phần giờ VN của 1 mốc thời gian */
export function vnParts(date) {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute };
}

/** "14:30 20/10" */
export function vnTime(date) {
  const p = vnParts(date);
  return `${p.hh}:${p.mm} ${p.d}/${p.m}`;
}

/** "14:30" */
export function vnClock(date) {
  const p = vnParts(date);
  return `${p.hh}:${p.mm}`;
}

/** "2026-10-20" theo ngày VN */
export function vnDateKey(date) {
  const p = vnParts(date);
  return `${p.y}-${p.m}-${p.d}`;
}

/** 370000 -> "370.000đ" */
export const money = (n) => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;

/** Tên gọi ngắn hiện cho thợ trước khi nhận đơn (không lộ họ tên đầy đủ): "Nguyễn Văn An" -> "An" */
export const givenName = (fullName) => (fullName ? fullName.trim().split(/\s+/).pop() : 'Khách hàng');
