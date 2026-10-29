/**
 * Hàm điểm Weighted Scoring của ghép cặp thợ – đơn (thuần, không truy cập CSDL).
 *
 *   S(thợ, đơn) = w_d·s_distance + w_t·s_trust + w_s·s_skill + w_a·s_acceptance + w_l·s_workload
 *   mỗi s_k thuộc [0, 1], Σw = 1  =>  S thuộc [0, 1]
 *
 *   s_distance   = 1 - d / R            d: khoảng cách PostGIS (m), R: bán kính tìm của cấu hình
 *   s_trust      = trust_score          điểm tin cậy 0..1 (algorithms/trust.js); thợ mới chưa có lịch sử
 *                                       (trust_score = 0) dùng 0.5 khi ghép (cold start, services/matching/candidate.js)
 *   s_skill      = min(số năm kinh nghiệm, 10) / 10
 *   s_acceptance = tỷ lệ nhận đơn 30 ngày (services/matching/stats.js)
 *   s_workload   = 1 - min(số đơn trong ngày, 5) / 5   (chia đều việc)
 *
 * Dùng chung cho:
 *   - trang "Mô phỏng" của web quản trị (services/admin/matching.service.js -> rankCandidates)
 *   - bộ điều phối thật (services/matching/dispatch.service.js -> rankForDispatch)
 * nên điểm admin thấy khi mô phỏng = điểm hệ thống dùng khi gửi lời mời.
 */
export const WEIGHT_KEYS = ['w_distance', 'w_trust', 'w_skill', 'w_acceptance', 'w_workload'];

const MAX_SKILL_YEARS = 10;
const MAX_JOBS_PER_DAY = 5;

const clamp = (v) => Math.max(0, Math.min(1, v));

/** 5 tiêu chí đã chuẩn hoá về [0, 1] của 1 ứng viên */
export const criteriaOf = (candidate, radiusKm) => ({
  distance: clamp(1 - candidate.distance_m / (radiusKm * 1000)),
  trust: clamp(candidate.trust_score),
  skill: clamp(candidate.skill_years / MAX_SKILL_YEARS),
  acceptance: clamp(candidate.acceptance_rate),
  workload: clamp(1 - candidate.jobs_today / MAX_JOBS_PER_DAY),
});

/** Điểm tổng S của 1 ứng viên theo trọng số của cấu hình ghép đang bật */
export const scoreCandidate = (candidate, config) => {
  const criteria = criteriaOf(candidate, config.max_radius_km);
  const score =
    config.w_distance * criteria.distance +
    config.w_trust * criteria.trust +
    config.w_skill * criteria.skill +
    config.w_acceptance * criteria.acceptance +
    config.w_workload * criteria.workload;
  return { ...candidate, criteria, score };
};

/** Trang Mô phỏng của admin: chấm điểm + sắp xếp giảm dần */
export const rankCandidates = (candidates, config) =>
  candidates.map((c) => scoreCandidate(c, config)).sort((a, b) => b.score - a.score);

/**
 * Bộ điều phối: như rankCandidates nhưng xếp hạng ỔN ĐỊNH (không phụ thuộc thứ tự CSDL trả về):
 * hoà điểm thì thợ gần hơn đứng trước, rồi tới id nhỏ hơn -> chạy lại cho cùng kết quả, kiểm thử được.
 */
export const rankForDispatch = (candidates, config) =>
  candidates
    .map((c) => scoreCandidate(c, config))
    .sort((a, b) => b.score - a.score || a.distance_m - b.distance_m || Number(a.id) - Number(b.id));
