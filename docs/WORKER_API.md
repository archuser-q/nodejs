# API App Thợ (`/api/worker`) — Thành viên B

Dùng chung database và quy ước với API app khách (`docs/CUSTOMER_API.md`):

- Đăng nhập trả `{ token, user }` (JWT, mặc định 30 ngày, role `worker`); các API còn lại gửi `Authorization: Bearer <token>`.
- Trả JSON trực tiếp. Lỗi luôn là `{ "message": "..." }` bằng tiếng Việt, hiển thị được ngay trên app.
- Danh sách phân trang trả `{ items, total, page, pageSize }`, query `?page=1&pageSize=20`.
- Giờ trả dạng ISO 8601 (UTC, đuôi `Z`); app tự đổi sang giờ Việt Nam khi hiển thị.
- Tiền là số nguyên VND. Toạ độ của app thợ dùng `latitude` / `longitude` (trùng tên với API vị trí của điện thoại).

## Endpoint

| Nhóm | Method & path | Ghi chú |
|---|---|---|
| Đăng nhập | `POST /auth/register` `{ full_name, email, password, phone? }` | mật khẩu ≥ 8 ký tự; trả `{ token, user }` |
| | `POST /auth/login` `{ identifier, password }` | identifier = email hoặc SĐT; tài khoản không phải thợ → 403 |
| | `GET /auth/providers` | client id Google / Facebook để app bật nút (null = ẩn) |
| | `POST /auth/google` `{ id_token \| access_token }` · `POST /auth/facebook` `{ access_token }` | server tự hỏi lại Google/Facebook; email đã xác minh trùng thì liên kết vào tài khoản cũ; trả thêm `is_new` |
| | `POST /auth/forgot-password` `{ email }` · `POST /auth/reset-password` `{ email, code, new_password }` | mã 6 số, 15 phút, sai 5 lần thì huỷ; chưa có SMTP + không phải production thì trả `debug_code` |
| | `GET /auth/me` · `POST /auth/change-password` `{ old_password?, new_password }` | tài khoản Google/Facebook chưa có mật khẩu thì không cần mật khẩu cũ |
| Hồ sơ | `GET /me` | user, profile (trạng thái, điểm, hạng thợ, vị trí, ví), skills, documents, bank_account, onboarding (còn thiếu gì, được gửi duyệt chưa), settings |
| | `PATCH /profile` `{ full_name?, phone?, avatar_url?, bio?, experience_years?, service_radius_km? }` | bán kính nhận việc 1–30 km |
| | `PUT /skills` `{ skills: [{ category_id, years }] }` | nhóm dịch vụ (danh mục) nhận làm + số năm kinh nghiệm → bảng `worker_skills` |
| Giấy tờ | `GET /documents` · `POST /documents` `{ doc_type, file_url }` · `DELETE /documents/:id` | `id_card_front`, `id_card_back`, `portrait`, `certificate` (≤ 5). Giấy tờ đã duyệt không gỡ được; gửi ảnh mới thì chờ duyệt, ảnh cũ vẫn hiệu lực |
| | `POST /verification/submit` | đủ SĐT + nhóm dịch vụ + 3 giấy tờ bắt buộc → `submitted_at`, báo admin |
| Ngân hàng | `GET /bank-account` · `PUT /bank-account` `{ bank_name, account_number, account_holder }` | |
| Nhận đơn | `GET /home` | trạng thái, lý do chưa bật được, thu nhập hôm nay / 7 ngày, offer đang chờ, việc đang làm, lịch sắp tới, chế độ ghép |
| | `PATCH /availability` `{ online, latitude?, longitude? }` | bật cần hồ sơ đã duyệt, có SĐT, có kỹ năng, ví không âm quá hạn mức, vị trí còn mới. Tắt thì offer đang giữ được chuyển cho thợ khác |
| | `PATCH /location` `{ latitude, longitude }` | app gửi định kỳ; đang làm đơn thì lưu vết + đẩy `worker:location` cho khách |
| | `GET /offers/current` | lời mời đang chờ (null nếu không có): đơn, khoảng cách, thực nhận dự kiến, điểm phù hợp, đợt, chế độ, giây còn lại |
| | `POST /offers/:offerId/accept` · `POST /offers/:offerId/reject` `{ reason? }` | ai nhận trước được đơn (409 nếu đã có thợ khác / hết giờ) |
| Đơn của tôi | `GET /orders?group=active\|completed\|cancelled\|history` · `GET /orders/:id` | chi tiết kèm khách (SĐT chỉ hiện khi đang làm và 7 ngày sau), ảnh, báo giá, thanh toán, đánh giá, bảo hành, thu nhập, các cờ `can_*`, `next_status` |
| | `POST /orders/:id/status` `{ status, safety_confirmed? }` | `on_the_way → arrived → in_progress → completed`. Đơn hẹn: chỉ đi trong 60 phút trước giờ hẹn. Bắt đầu sửa cần `safety_confirmed: true`. Hoàn thành cần ≥ 1 ảnh sau và không còn báo giá chờ duyệt |
| | `POST /orders/:id/cancel` `{ reason }` | chưa tới nơi: đơn quay lại hàng đợi tìm thợ khác (`status: matching`); đã tới nơi: huỷ đơn; đang sửa: không huỷ được |
| | `POST /orders/:id/photos` `{ kind: before\|after, urls[] }` · `DELETE /orders/:id/photos/:photoId` | tối đa 6 ảnh mỗi loại |
| | `POST /orders/:id/extra-quotes` `{ description, amount }` · `POST /orders/:id/extra-quotes/:quoteId/cancel` | chỉ sau khi đã đến nơi; 1 báo giá chờ duyệt một lúc; khách duyệt ở app khách |
| | `POST /orders/:id/confirm-cash` | xác nhận đã thu tiền mặt (đi qua `settlePayment` của app khách → ví trừ hoa hồng) |
| | `POST /orders/:id/report` `{ reason, description? }` · `GET /reports` | báo cáo sự cố → bảng `complaints` (cột `reporter_id`), admin xử lý ở trang Khiếu nại |
| Chat | `GET /orders/:id/messages?before_id=&limit=` · `POST /orders/:id/messages` `{ content?, image_url? }` · `POST /orders/:id/messages/read` | dùng chung bảng `messages` với app khách; trả thêm `is_mine` |
| Thu nhập | `GET /earnings/summary?period=today\|week\|month` · `GET /earnings` | tổng / phí / thực nhận, so cùng kỳ, biểu đồ theo ngày (giờ VN), đơn chưa thanh toán |
| Ví | `GET /wallet` · `GET /wallet/transactions` | số dư = `workers.wallet_balance`, mỗi biến động 1 dòng `worker_transactions` (`balance_after`) |
| | `POST /wallet/withdrawals` `{ amount }` · `GET /wallet/withdrawals` | tối thiểu 50.000đ, cần ngân hàng; demo duyệt ngay (`WITHDRAWAL_AUTO_APPROVE`) |
| | `POST /wallet/topup` `{ amount, method: momo\|vnpay }` | nạp sandbox để bù hoa hồng đơn tiền mặt (tắt ở production) |
| Đánh giá | `GET /reviews?rating=` · `GET /performance` | phân bố sao; tỷ lệ nhận đơn / hoàn thành / huỷ 30 ngày, điểm tin cậy |
| Danh mục | `GET /catalog/categories` · `GET /catalog/services?category_id=` | không cần đăng nhập (dùng lại API danh mục của app khách) |
| Thông báo | `GET /notifications` · `GET /notifications/unread-count` · `PATCH /notifications/:id/read` · `PATCH /notifications/read-all` | dùng chung bảng `notifications` |
| | `POST /device-tokens` `{ token, platform }` · `DELETE /device-tokens/:token` | Expo push (bật bằng `PUSH_ENABLED=true`) |

Dùng chung cho app khách và app thợ:

| Method & path | Ghi chú |
|---|---|
| `POST /api/uploads` (multipart, trường `file`) | cần đăng nhập; JPG/PNG/WEBP/HEIC ≤ 8 MB, nhận dạng theo nội dung file; trả `{ url, path, size, content_type }` |
| `GET /media/...` | ảnh đã tải lên (tên file ngẫu nhiên) |
| `GET /api/health` | `{ status: "ok" }` |

API admin bổ sung (cookie admin như các API dashboard khác):

| Method & path | Ghi chú |
|---|---|
| `GET /api/admin/dispatch/status` | vòng điều phối (leader, số nhịp, lần ghép gần nhất), hàng đợi theo chế độ, số offer đang mở |
| `PUT /api/admin/dispatch/mode` `{ mode: instant\|batch\|auto, max_offers? }` | đổi chế độ của cấu hình đang bật (dùng khi demo / thực nghiệm) |
| `GET /api/admin/withdrawals?status=` · `POST /api/admin/withdrawals/:id/approve` · `.../reject` `{ note }` | khi tắt duyệt rút tiền tự động; từ chối thì hoàn tiền vào ví |
| `POST/PUT /api/admin/matching-configs` | nhận thêm `mode`, `max_offers` (không gửi thì giữ nguyên) |

## Realtime (Socket.IO, cùng cổng với API)

Thợ kết nối giống app khách: `io('http://<server>:3000', { auth: { token } })`.

| Sự kiện | Payload | Khi nào |
|---|---|---|
| `offer:new` | `{ offer_id, order_id, expires_at }` | có lời mời nhận đơn |
| `offer:closed` | `{ offer_id, order_id }` | lời mời hết giờ / đơn đã có thợ khác nhận / khách huỷ |
| `order:updated` | `{ order_id, status }` | khách duyệt báo giá, thanh toán, huỷ đơn... |
| `message:new` | Message | tin nhắn mới |
| `notification:new` | Notification | thông báo mới |

Loại thông báo (`type`) app thợ nhận: `offer`, `order` (kèm `data.kind = schedule_reminder` khi nhắc lịch), `quote`, `chat`, `payment` (rút tiền có `data.withdrawal_id`), `review`, `warranty`, `verification`.
