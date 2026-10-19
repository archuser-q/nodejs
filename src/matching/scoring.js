/**
 * Hàm điểm Weighted Scoring dùng cho ghép cặp.  [Thành viên B]
 *
 *   S(thợ, đơn) = w_d·s_distance + w_t·s_trust + w_s·s_skill + w_a·s_acceptance + w_l·s_workload
 *   mỗi s_k thuộc [0, 1], Σw = 1  =>  S thuộc [0, 1]
 *
 *   s_distance   = 1 - d / R            d: khoảng cách PostGIS (m), R: bán kính tìm của cấu hình
 *   s_trust      = trust_score          điểm tin cậy 0..1 (thuật toán Trust Score – thành viên A);
 *                                       thợ mới chưa có đơn/đánh giá mà trust_score = 0 -> 0.5 (cold start, candidate.js)
 *   s_skill      = min(năm KN ở đúng danh mục, 10) / 10
 *   s_acceptance = tỷ lệ nhận đơn 30 ngày (module này cập nhật, xem services/matching/stats.js)
 *   s_workload   = 1 - min(số đơn trong ngày, 5) / 5   (chia đều việc)
 *
 * Công thức tiêu chí nằm ở services/scoring.js (dùng chung với trang "Mô phỏng" của web quản trị),
 * nên điểm admin thấy khi mô phỏng = điểm bộ điều phối dùng thật. File này thêm phần xếp hạng
 * ổn định cho điều phối: hoà điểm thì thợ gần hơn đứng trước, rồi tới id nhỏ hơn.
 */
import { WEIGHT_KEYS, criteriaOf, scoreCandidate } from '../services/scoring.js';

export { WEIGHT_KEYS, criteriaOf, scoreCandidate };

/** Chấm điểm + sắp xếp giảm dần (ổn định, không phụ thuộc thứ tự DB trả về) */
export const rankForDispatch = (candidates, config) =>
  candidates
    .map((c) => scoreCandidate(c, config))
    .sort((a, b) => b.score - a.score || a.distance_m - b.distance_m || Number(a.id) - Number(b.id));
