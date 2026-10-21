# API web quản trị bổ sung khi ghép với app thợ

Tất cả dùng cookie admin (`requireAdmin`) như các API dashboard cũ. Lỗi trả `{ "message": "..." }` tiếng Việt.

| Method & path | Ghi chú |
|---|---|
| `GET /api/admin/workers?review=needed` | hàng chờ duyệt: hồ sơ đã bấm "Gửi hồ sơ" (`submitted_at` khác null) + thợ đã duyệt gửi giấy tờ mới. Xếp theo `submitted_at` (gửi trước duyệt trước). Mỗi dòng có thêm `submitted_at`, `is_busy`, `pending_docs`, `needs_review` |
| `GET /api/admin/workers/:id` | thêm `worker.submitted_at`, `verified_by_name`, `location_updated_at`; `documents[].is_current` (bản mới nhất của loại giấy đó), `reviewed_by_name`; `bankAccount` |
| `PATCH /api/admin/workers/:id/documents/:docId` `{ status: approved\|rejected, reject_reason? }` | **duyệt từng giấy**. Từ chối bắt buộc có lý do, lưu vào `worker_documents.reject_reason` (app thợ hiện dưới đúng giấy đó). Thợ đã được duyệt thì báo ngay (`type: verification`); hồ sơ đang chờ thì đợi admin chốt cả hồ sơ mới báo. Không cho từ chối bản hợp lệ duy nhất của giấy bắt buộc khi thợ đang hoạt động |
| `PATCH /api/admin/workers/:id/verification` `{ status, note? }` | giữ nguyên request/response. Khác trước: **duyệt** chỉ duyệt các giấy đang chờ (không biến giấy đã bị từ chối thành đã duyệt) và báo lỗi nếu còn thiếu giấy bắt buộc hợp lệ; **từ chối** chỉ đổi trạng thái hồ sơ + ghi lý do, giấy hợp lệ giữ nguyên để thợ chỉ tải lại giấy bị từ chối |
| `GET /api/admin/complaints?source=customer\|worker` | lọc theo người gửi. Mỗi dòng có `source`, `reporter_id`; chi tiết có thêm `reporter_name` |
| `PATCH /api/admin/complaints/:id` | sau khi cập nhật, báo cho người gửi (`type: complaint`, `data.order_id`): thợ nếu là báo cáo sự cố, khách nếu là khiếu nại |
| `GET /api/admin/orders/:id` | thêm `photos` (ảnh trước/sau của thợ), `offers` (lịch sử lời mời: thợ, đợt, điểm, khoảng cách, kết quả), `trail` (vết di chuyển của thợ), `dispatch` (hàng đợi ghép cặp), `order.safety_checked_at` |
| `GET /api/admin/monitor/map` | bản đồ giám sát: `orders` đang chạy (toạ độ, thợ, tình trạng ghép) + `workers` đã duyệt có vị trí (`is_online`, `is_busy`, `location_fresh`, `current_order_code`) |
| `GET /api/admin/dashboard/pending` | việc cần xử lý: hồ sơ cần duyệt, lệnh rút chờ duyệt (+ tổng tiền), khiếu nại của khách, báo cáo của thợ, đơn đang tìm thợ / chờ quá 5 phút |
| `GET /api/admin/notifications?page&pageSize&unread=true` · `PATCH /:id/read` · `PATCH /read-all` | thông báo gửi cho tài khoản admin (VD "Hồ sơ thợ chờ duyệt" do app thợ tạo); trả thêm `unread` |

Web quản trị cũng dùng các API có sẵn của thành viên B: `GET /api/admin/dispatch/status`, `PUT /api/admin/dispatch/mode`, `GET/POST /api/admin/withdrawals...`.

Khác:
- "Doanh thu tháng này" và "Đơn hàng hôm nay" ở trang tổng quan tính theo giờ Việt Nam.
- Thông báo lỗi / thành công của các API admin đổi sang tiếng Việt (trừ các dòng có đánh dấu `[B]`).
- Kiểm thử: `test/admin-dashboard.test.js` (6 ca).
