# API App Khách hàng (`/api/customer`)

Dùng chung backend, CSDL và quy ước với app thợ (`docs/WORKER_API.md`) và web quản trị:

- Đăng nhập trả `{ token, user }` (JWT, mặc định 30 ngày, role `customer`); các API còn lại gửi `Authorization: Bearer <token>`.
- Trả JSON trực tiếp. Lỗi luôn là `{ "message": "..." }` bằng tiếng Việt, app hiển thị thẳng.
- Danh sách phân trang trả `{ items, total, page, pageSize }`, query `?page=1&pageSize=10`.
- Giờ trả ISO 8601 (UTC); app tự đổi sang giờ Việt Nam. Tiền là số nguyên VND. Toạ độ của app khách dùng `lat` / `lng`.
- Phạm vi chỉ gồm **dịch vụ của thợ điện** (4 nhóm: Sửa chữa điện · Lắp đặt thiết bị điện · Đồ điện gia dụng · Đi dây & tủ điện).

## Chạy thử

```bash
npm install
npm run migrate up
npm run seed:demo          # danh mục điện, thợ demo, khách khach@thonhanh.vn / 12345678 (SĐT 0912000001)
npm run dev
```

Không cần app thợ trong tay: `npm run bots` (hoặc `docker compose --profile bots up -d`) để thợ ảo tự nhận và làm đơn,
hoặc mở app thợ bản web. Đóng vai khách bằng script: `npm run demo:customer -- order` (xem đầu file `scripts/demo-customer.js`).

## Endpoint

| Nhóm | Method & path | Ghi chú |
|---|---|---|
| Đăng nhập | `POST /auth/register` `{ full_name, email, phone?, password }` | mật khẩu dùng chung `password()` với app thợ: 8–72 ký tự, có cả chữ và số, chặn mật khẩu quá phổ biến (áp cho cả đổi / đặt lại mật khẩu); cần ít nhất email hoặc SĐT (app gửi cả hai); trả `{ token, user }` |
| | `POST /auth/login` `{ identifier, password }` | identifier = email hoặc SĐT; tài khoản thợ / admin → 403 |
| | `GET /auth/providers` | client id Google / Facebook để app bật nút (null = ẩn) |
| | `POST /auth/google` `{ id_token \| access_token }` · `POST /auth/facebook` `{ access_token }` | backend tự xác minh lại với Google/Facebook (dùng chung `services/worker/social.js`); email đã xác minh trùng thì liên kết vào tài khoản cũ; trả thêm `is_new` |
| | `POST /auth/forgot-password` `{ email }` · `POST /auth/reset-password` `{ email, code, new_password }` | mã 6 số qua email, 15 phút, sai 5 lần thì huỷ; chưa có SMTP và không phải production thì trả `debug_code` |
| | `GET /auth/me` | `{ user, has_password }` (tài khoản Google/Facebook chưa có mật khẩu → `false`) |
| | `POST /auth/change-password` `{ old_password?, new_password }` | chưa có mật khẩu thì không cần mật khẩu cũ |
| Hồ sơ | `PATCH /profile` `{ full_name?, email?, phone?, avatar_url? }` | email/SĐT không trùng người khác; không bỏ được cả email lẫn SĐT |
| Thiết bị | `POST /device-tokens` `{ token, platform }` · `DELETE /device-tokens/:token` | Expo push (bật bằng `PUSH_ENABLED=true`) |
| Địa chỉ | `GET /addresses` · `POST /addresses` `{ label?, address_text, lat, lng, is_default? }` | địa chỉ đầu tiên tự làm mặc định |
| | `PATCH /addresses/:id` · `DELETE /addresses/:id` | |
| Danh mục | `GET /catalog/categories` · `GET /catalog/services?category_id=&search=` | không cần đăng nhập |
| Đơn | `POST /orders` `{ service_id, address_id, description?, scheduled_at?, image_urls? }` | xem "Quy tắc đặt đơn" bên dưới; trả chi tiết đơn |
| | `GET /orders?group=active\|completed\|cancelled` · `GET /orders/:id` | chi tiết: `history`, `extra_quotes`, `payments`, `review`, `warranty`, `photos`, `searching`, `safety_checked_at`, thợ (kèm `level`, `has_certificate`), các cờ `can_*`. Chỉ đọc, không ghi CSDL |
| | `POST /orders/:id/cancel` `{ reason }` | chỉ khi `pending / matching / accepted` (huỷ theo mẫu: đóng lời mời `reason='closed'`, báo `offer:closed`, `refreshAvailability`) |
| | `GET /orders/:id/tracking` | vị trí thợ (khi đơn đang chạy) |
| | `POST /orders/:id/quotes/:quoteId/approve` · `.../reject` | báo giá phát sinh đang `pending` (thợ rút thì thành `cancelled`) |
| Chat | `GET /orders/:id/messages?before_id=&limit=` · `POST /orders/:id/messages` `{ content?, image_url? }` · `POST /orders/:id/messages/read` | gửi chữ, ảnh hoặc cả hai; ảnh tải qua `POST /api/uploads` |
| Thanh toán | `POST /orders/:id/payments` `{ method: momo\|vnpay }` | chỉ khi đơn `completed`. **Không nhận tiền mặt**: `cash` → 400 |
| | `POST /payments/:id/sandbox-confirm` | giả lập MoMo/VNPay, tắt ở production. Mọi thanh toán thành công đi qua `settlePayment()` → `recordPaidOrder()` (ví thợ, hoa hồng) |
| | `GET /payments` | lịch sử giao dịch |
| Đánh giá | `POST /orders/:id/review` `{ rating 1-5, comment? }` · `GET /reviews` | cập nhật `rating_avg`, `rating_count`; `trust_score` do thành viên A tính |
| Khiếu nại | `POST /orders/:id/complaints` `{ title, content }` · `GET /complaints` | không hiện báo cáo do thợ gửi (`reporter_id` khác null) |
| Bảo hành | `POST /orders/:id/warranty-claim` `{ content }` | còn hạn `warranty_until`; lưu vào `complaints` type `warranty` (xem đề xuất luồng bên dưới) |
| Thợ | `GET /workers/:id` | hồ sơ công khai: hạng thợ, có chứng chỉ nghề điện, kỹ năng, 5 đánh giá gần nhất |
| Thông báo | `GET /notifications?unread_only=` · `GET /notifications/unread-count` · `PATCH /notifications/:id/read` · `PATCH /notifications/read-all` | |

Dùng chung với app thợ: `POST /api/uploads` (multipart, trường `file`, cần đăng nhập, ảnh ≤ 8 MB) trả `{ url }`; ảnh phục vụ ở `/media/...`.

### Quy tắc đặt đơn

- **Cần số điện thoại** (để thợ gọi khi đến). Tài khoản Google/Facebook chưa có SĐT → 400, app nhắc thêm SĐT trước.
- **Khách không chọn chế độ ghép.** Trường `matching_mode` gửi lên bị bỏ qua; bộ điều phối chọn theo cấu hình admin đang bật
  (`instant` / `batch` / `auto`) và ghi lại `orders.matching_mode` là chế độ thực tế đã dùng (`instant` hoặc `batch`).
- **Giờ hẹn** (`scheduled_at`) phải cách hiện tại **≥ 60 phút**, tối đa 30 ngày, trong khung giờ **7:00–21:00 giờ VN**
  (đổi bằng biến `BOOKING_HOURS`, VD `6-22`; để trống `BOOKING_HOURS=` thì bỏ giới hạn). Đơn "làm ngay" đặt được mọi lúc.
- **Còn đơn đã hoàn thành mà chưa thanh toán** → 400 "Bạn chưa thanh toán đơn TN…". App khách mở đơn đó để khách trả trước.
- **Ảnh tình trạng** `image_urls`: tối đa 6 URL ảnh đã tải lên. App thợ hiển thị trong lời mời và chi tiết đơn.
- Sau khi lưu, đơn được đưa vào hàng đợi bằng `dispatchOffers(orderId)`; mọi việc còn lại (mời theo đợt, hết hạn, ghép theo lô,
  huỷ đơn quá hạn chờ) do bộ điều phối chạy nền của thành viên B lo.
- Thợ huỷ khi chưa tới nơi: đơn quay về `matching`, `worker = null` và được tìm thợ khác — app khách đưa người dùng về màn "Thợ phù hợp".

### Trường `searching` (tiến độ tìm thợ)

Có khi đơn đang `matching`: `{ mode, rounds, offers_sent, last_candidates, deadline_at, last_attempt_at }` (đọc từ `order_dispatches`).
App hiển thị "Đợt mời N · đã mời M thợ · chờ tối đa tới HH:MM".

## Realtime (Socket.IO, cùng cổng với API)

```js
const socket = io('http://<server>:3000', { auth: { token } });
```

| Sự kiện | Payload | Khi nào |
|---|---|---|
| `order:updated` | `{ order_id, status }` | thợ nhận đơn / đổi trạng thái / huỷ, báo giá, ảnh, thanh toán |
| `worker:location` | `{ order_id, lat, lng, updated_at }` | thợ đang làm đơn gửi vị trí (app thợ gửi định kỳ) |
| `message:new` | Message | có tin nhắn trong đơn |
| `notification:new` | Notification | có thông báo mới (`type`: `order`, `quote`, `chat`, `payment`, `review`, `warranty`) |

## Cấu trúc phần App Khách hàng

```
src/routes/customer/index.js              router /api/customer
src/controllers/customer/*.controller.js  kiểm tra dữ liệu vào (dùng utils/validate.js)
src/services/customer/
  auth.service.js         đăng ký/đăng nhập email-SĐT, Google, Facebook, quên / đổi mật khẩu
  account.service.js      hồ sơ, địa chỉ, xem danh mục
  order.service.js        tạo / xem / huỷ đơn, tracking, duyệt báo giá
  interaction.service.js  chat, thanh toán, đánh giá, khiếu nại, bảo hành, hồ sơ thợ
  notify.service.js       thông báo + đẩy socket + push
  dispatch.service.js     lớp chuyển tiếp sang bộ điều phối của B
  common.js               transaction, phân trang, hằng trạng thái
src/middlewares/requireCustomer.js        xác thực Bearer token
test/customer-app.test.js                 kiểm thử tích hợp phần app khách (chạy trong npm test)
```

## Đề xuất luồng bảo hành (cần nhóm chốt, rồi B làm phần app thợ)

Hiện tại khách gửi yêu cầu bảo hành → tạo `complaints` loại `warranty` → admin xử lý ở trang Khiếu nại. Đề xuất bước tiếp theo:

1. Admin duyệt yêu cầu (`processing`) và bấm "Tạo đơn bảo hành".
2. Backend tạo đơn mới **0đ** cùng dịch vụ, địa chỉ, ảnh của đơn gốc; ghi liên kết đơn gốc (cần migration mới, VD cột `orders.warranty_of`).
3. Mời **thợ cũ** trước (1 lời mời, hết giờ / thợ đã nghỉ thì đưa vào hàng đợi bình thường).
4. Đơn bảo hành không tính hoa hồng, không thanh toán; hoàn thành thì đóng khiếu nại (`resolved`).
5. App khách: đơn bảo hành hiện nhãn "Bảo hành" và liên kết về đơn gốc.
