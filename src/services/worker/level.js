/**
 * Hạng thợ theo kinh nghiệm thực tế trên nền tảng: mốc số đơn hoàn thành + điểm đánh giá tối thiểu.
 * Chỉ để hiển thị và tạo động lực — KHÔNG ảnh hưởng thuật toán ghép cặp.  [Thành viên B]
 */
const LEVELS = [
  { key: 'dong', name: 'Thợ Đồng', jobs: 0, rating: 0 },
  { key: 'bac', name: 'Thợ Bạc', jobs: 30, rating: 4.5 },
  { key: 'vang', name: 'Thợ Vàng', jobs: 100, rating: 4.7 },
  { key: 'kim_cuong', name: 'Thợ Kim cương', jobs: 300, rating: 4.85 },
];

export function workerLevel(completed, rating) {
  const r = rating === null || rating === undefined ? 5 : Number(rating);
  let idx = 0;
  LEVELS.forEach((l, i) => {
    if (completed >= l.jobs && r >= l.rating) idx = i;
  });
  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1] ?? null;
  const progress = next ? Math.max(0, Math.min(1, (completed - cur.jobs) / Math.max(1, next.jobs - cur.jobs))) : 1;
  return {
    key: cur.key,
    name: cur.name,
    completed,
    next_name: next?.name ?? null,
    next_jobs: next?.jobs ?? null,
    next_rating: next?.rating ?? null,
    progress: Math.round(progress * 1000) / 1000,
  };
}
