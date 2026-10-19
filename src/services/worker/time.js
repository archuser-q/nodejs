/** Mốc thời gian theo giờ Việt Nam (UTC+7, không có giờ mùa hè) cho thống kê thu nhập.  [B] */
const VN = 7 * 3600_000;
const DAY = 86_400_000;

export const vnDayStart = (t = Date.now()) => {
  const v = new Date(t + VN);
  v.setUTCHours(0, 0, 0, 0);
  return v.getTime() - VN;
};

/** Thứ 2 đầu tuần */
export const vnWeekStart = (t = Date.now()) => {
  const day = vnDayStart(t);
  const dow = (new Date(day + VN).getUTCDay() + 6) % 7; // 0 = Thứ 2
  return day - dow * DAY;
};

export const vnMonthStart = (t = Date.now(), addMonths = 0) => {
  const v = new Date(t + VN);
  return Date.UTC(v.getUTCFullYear(), v.getUTCMonth() + addMonths, 1) - VN;
};

/** "YYYY-MM-DD" theo ngày VN */
export const vnKey = (t) => new Date(t + VN).toISOString().slice(0, 10);

/** Thứ trong tuần theo giờ VN: 0 = Thứ 2 ... 6 = Chủ nhật */
export const vnWeekday = (t) => (new Date(t + VN).getUTCDay() + 6) % 7;

export const vnDayOfMonth = (t) => new Date(t + VN).getUTCDate();

export { DAY };
