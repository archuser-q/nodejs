/**
 * ĐIỂM NỐI VỚI MODULE GHÉP CẶP (Thành viên B) — giữ nguyên tên hàm app khách đang gọi.
 *
 *  - dispatchOffers(orderId): gọi sau khi tạo đơn -> đưa đơn vào hàng đợi của bộ điều phối
 *    (chế độ instant gửi đợt offer đầu tiên ngay; auto/batch do vòng điều phối xử lý trong vài giây).
 *  - refreshOffers(orderId): gọi khi khách xem đơn đang tìm thợ -> chỉ đảm bảo đơn đã ở trong hàng đợi.
 *    Hết hạn offer, gửi đợt tiếp, ghép theo lô, huỷ đơn quá hạn... đều do vòng điều phối chạy nền
 *    (src/services/matching/dispatcher.js), không phụ thuộc việc khách có mở app hay không.
 *  - getConfig(db, id?): cấu hình ghép cặp đang bật (order.service dùng để ghi matching_config_id).
 *
 * Chế độ ghép do HỆ THỐNG chọn theo cấu hình admin (matching_configs.mode), app khách không cần gửi
 * matching_mode; orders.matching_mode được ghi lại bằng chế độ thực tế đã dùng.
 */
import { enqueue } from '../matching/dispatch.service.js';

export { getConfig } from '../matching/config.js';

export const dispatchOffers = (orderId) => enqueue(orderId);

export const refreshOffers = (orderId) => enqueue(orderId, { runNow: false });
