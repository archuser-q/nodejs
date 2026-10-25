# API App Khách hàng (`/api/customer`)

Dùng chung database với web quản trị. Đăng nhập trả về `token` (JWT, mặc định 30 ngày);
các API còn lại gửi header `Authorization: Bearer <token>`. Lỗi luôn có dạng `{ "message": "..." }` (tiếng Việt).
Danh sách phân trang trả `{ items, total, page, pageSize }` (query `?page=1&pageSize=10`), giống API dashboard.

## Chạy thử

```bash
npm install
npm run migrate up
npm run dev
```

Muốn test khi chưa có app thợ: dùng thư mục `dev-tools/` (xem `dev-tools/README.md`):

```bash
npm run seed:dev          # dịch vụ, cấu hình ghép cặp, 40 thợ quanh Hà Nội, khách 0912345678 / 123456
npm run simulate -- <mã đơn> accept|on_the_way|move|arrived|in_progress|quote|msg|completed|confirm-cash|auto
```

## Endpoint

| Nhóm | Method & path | Ghi chú |
|---|---|---|
| Auth | `POST /auth/register` `{ full_name, phone, password, email? }` | trả `{ token, user }` |
| | `POST /auth/login` `{ identifier, password }` | identifier = SĐT hoặc email |
| | `GET /auth/me` | `{ user }` |
| Hồ sơ | `PATCH /profile` `{ full_name?, email? }` | `{ user }` |
| Địa chỉ | `GET /addresses` · `POST /addresses` `{ label?, address_text, lat, lng, is_default? }` | địa chỉ đầu tiên tự làm mặc định |
| | `PATCH /addresses/:id` · `DELETE /addresses/:id` | |
| Danh mục | `GET /catalog/categories` · `GET /catalog/services?category_id=&search=` | không cần đăng nhập |
| Đơn | `POST /orders` `{ service_id, address_id, description?, scheduled_at?, matching_mode? }` | tạo đơn `matching`, bộ điều phối của B ghép thợ (xem `docs/MATCHING.md`). **[B]** Còn đơn đã xong mà chưa thanh toán → 400 "Bạn chưa thanh toán đơn ..." |
| | `GET /orders?group=active\|completed\|cancelled` · `GET /orders/:id` | chi tiết kèm history, extra_quotes, payments, review, warranty, can_* |
| | `POST /orders/:id/cancel` `{ reason }` | chỉ khi `pending/matching/accepted` |
| | `GET /orders/:id/tracking` | vị trí thợ (khi đơn đang chạy) |
| | `POST /orders/:id/quotes/:quoteId/approve` · `.../reject` | báo giá phát sinh |
| Chat | `GET /orders/:id/messages?before_id=&limit=` · `POST /orders/:id/messages` `{ content }` · `POST /orders/:id/messages/read` | |
| Thanh toán | `POST /orders/:id/payments` `{ method: momo\|vnpay }` | chỉ khi đơn `completed`. **[B]** Không nhận tiền mặt nữa: `cash` → 400 "Thợ Nhanh không nhận tiền mặt..." |
| | `POST /payments/:id/sandbox-confirm` | giả lập MoMo/VNPay, tắt ở production |
| | `GET /payments` | lịch sử giao dịch |
| Đánh giá | `POST /orders/:id/review` `{ rating 1-5, comment? }` · `GET /reviews` | cập nhật rating_avg/rating_count của thợ |
| Khiếu nại | `POST /orders/:id/complaints` `{ title, content }` · `GET /complaints` | |
| Bảo hành | `POST /orders/:id/warranty-claim` `{ content }` | còn hạn `warranty_until`, lưu vào `complaints` type `warranty` |
| Thợ | `GET /workers/:id` | hồ sơ công khai + 5 đánh giá gần nhất |
| Thông báo | `GET /notifications?unread_only=` · `GET /notifications/unread-count` · `PATCH /notifications/:id/read` · `PATCH /notifications/read-all` | |

## Realtime (Socket.IO, cùng cổng với API)

```js
const socket = io('http://<server>:3000', { auth: { token } });
```

| Sự kiện | Payload | Khi nào |
|---|---|---|
| `order:updated` | `{ order_id, status }` | đổi trạng thái, báo giá, thanh toán, đánh giá |
| `worker:location` | `{ order_id, lat, lng, updated_at }` | thợ gửi vị trí |
| `message:new` | Message | có tin nhắn trong đơn |
| `notification:new` | Notification | có thông báo mới |

## Phạm vi phần App Khách hàng

```
src/routes/customer/index.js             router /api/customer
src/controllers/customer/*.controller.js validate input
src/services/customer/
  account.service.js     đăng ký/đăng nhập, hồ sơ, địa chỉ, xem danh mục
  order.service.js       tạo/xem/huỷ đơn, tracking, duyệt báo giá
  interaction.service.js chat, thanh toán (chỉ ghi nhận), đánh giá, khiếu nại, bảo hành, xem hồ sơ thợ
  notify.service.js      thông báo + đẩy socket
  dispatch.service.js    ĐIỂM NỐI với module ghép cặp (cài đặt tạm, xem bên dưới)
  common.js              transaction, phân trang, hằng trạng thái
src/middlewares/requireCustomer.js       xác thực Bearer token
src/realtime/socket.js                   Socket.IO
```

**Không làm (để thành viên khác):**
- Thuật toán ghép cặp / gửi đề xuất cho thợ: `dispatch.service.js` chỉ là bản tạm gọi `findCandidates` + `rankCandidates`
  có sẵn. Người làm matching thay nội dung file, giữ tên 2 hàm `dispatchOffers(orderId)` và `refreshOffers(orderId)`.
- Ví thợ, hoa hồng (`worker_transactions`, `wallet_balance`, `commission_amount`): thanh toán phía khách chỉ đổi
  `payments.status = success` và điền `orders.final_price`.
- Trust score: đánh giá chỉ cập nhật `rating_avg`, `rating_count` của thợ.
- Thao tác của thợ (nhận đơn, đổi trạng thái, gửi vị trí, báo giá, xác nhận tiền mặt): chỉ có bản giả lập trong `dev-tools/`.

## Thay đổi ở file chung của nhóm (cần báo trước khi merge)

| File | Thay đổi |
|---|---|
| `src/app.js` | nối `/api/customer`; nạp `/api/dev` nếu có thư mục `dev-tools` (ngoài production); `CLIENT_ORIGIN` nhận nhiều địa chỉ cách dấu phẩy |
| `src/server.js` | `http.createServer` + Socket.IO, nghe `0.0.0.0` để điện thoại cùng Wi-Fi gọi được |
| `src/config/db.js` | thêm `sql()` / `q()` đọc BIGINT/NUMERIC thành number; `query()` cũ giữ nguyên |
| `src/config/env.js` | thêm `MOBILE_JWT_EXPIRES_IN` (tuỳ chọn, mặc định 30d) |
| `src/utils/jwt.js` | `signToken(payload, expiresIn?)` — tham số thứ 2 tuỳ chọn, gọi cũ không đổi |
| `src/middlewares/ErrorHandler.js` | body JSON sai trả 400 thay vì 500 |
| `package.json` | thêm `socket.io`; lệnh `seed:dev`, `simulate` (trỏ vào `dev-tools/`) |

## dev-tools/ (không thuộc phần app khách)

Công cụ test khi chưa có app thợ: giả lập thợ (`/api/dev`, `npm run simulate`) và dữ liệu mẫu (`npm run seed:dev`).
Có thể không đẩy lên nhánh chung, hoặc xoá khi app thợ xong — server vẫn chạy bình thường.
