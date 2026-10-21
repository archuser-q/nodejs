# Ghi chú cho thành viên nhóm (và trợ lý AI) khi làm việc trên THỢ NHANH

> Đọc file này **trước khi sửa code**. Claude Code thường tự đọc file `CLAUDE.md` ở thư mục gốc repo. Với công cụ khác, hãy bảo trợ lý đọc file này trước.
> Nếu đang làm trong repo ReactJS (app khách / web quản trị), chép file này sang thư mục gốc repo đó.
> Chi tiết lý do từng thay đổi của thành viên B: `docs/TICH_HOP_THANH_VIEN_B.md`.

## 1. Bối cảnh

THỢ NHANH là nền tảng kết nối khách hàng với **thợ điện**. Nhóm có 3 phần, dùng **chung 1 backend** (repo này) và 1 CSDL PostgreSQL/PostGIS:

| Phần | API | Người phụ trách | Tài liệu |
|---|---|---|---|
| Web quản trị (React, thư mục `dashboard` ở repo ReactJS) | `/api/admin/...` (cookie) | thành viên nhóm | — |
| App khách hàng (React Native) | `/api/customer/...` (Bearer) | thành viên nhóm | `docs/CUSTOMER_API.md` |
| App thợ + **thuật toán ghép cặp** | `/api/worker/...` (Bearer) | **thành viên B** | `docs/WORKER_API.md`, `docs/MATCHING.md` |
| Điểm tin cậy (Trust Score) | cập nhật `workers.trust_score` | thành viên A | mục 5 bên dưới |

Đã chốt:
- **Phạm vi chỉ gồm dịch vụ của thợ điện.** Danh mục là 4 nhóm chuyên môn: Sửa chữa điện · Lắp đặt thiết bị điện · Đồ điện gia dụng · Đi dây & tủ điện. Không thêm Nước, Điện lạnh, Khoá, Sơn...
- **Khách không chọn chế độ ghép.** Hệ thống tự ghép theo cấu hình admin đang bật, mặc định `auto` (đơn đứng riêng thì gửi ngay bằng Greedy, nhóm đơn tranh cùng thợ thì giải bằng Hungarian).
- Đăng nhập bằng email, Google hoặc Facebook (không dùng SMS OTP). Bản đồ dùng loại miễn phí. Mỗi phần chạy được bằng `docker compose up`.

## 2. Những điều KHÔNG được làm

1. **Không sửa phần của thành viên B** khi chưa trao đổi:
   - các thư mục `src/matching/`, `src/services/matching/`, `src/services/worker/`, `src/controllers/worker/`, `src/routes/worker/`;
   - các file `src/routes/upload.routes.js`, `src/routes/admin/dispatch.routes.js`, `migrations/1792200000000_worker-app-matching.sql`;
   - các đoạn có đánh dấu `[B]` trong file chung.

   Nếu thấy cần đổi, ghi vào mô tả Pull Request mục "Đề nghị gửi B" để B sửa.
2. **Không đổi API app thợ** (`/api/worker`, xem `docs/WORKER_API.md`) và các sự kiện Socket.IO (`offer:new`, `offer:closed`, `order:updated`, `message:new`, `notification:new`, `worker:location`). App thợ đang dùng đúng tên trường và định dạng hiện tại.
3. **Không gửi lời mời (offer) cho thợ trực tiếp.** Đơn mới chỉ cần gọi `dispatchOffers(orderId)` (`src/services/customer/dispatch.service.js`) sau khi đơn đã lưu; bộ điều phối lo phần còn lại. Không ghi thẳng vào `order_offers` / `order_dispatches`.
4. **Không tự cộng/trừ ví thợ.** Mọi thanh toán thành công phải đi qua `settlePayment()` (`src/services/customer/interaction.service.js`). Hàm này gọi `recordPaidOrder()` để chốt hoa hồng 15 %, có chống ghi trùng. Không sửa trực tiếp `workers.wallet_balance` hay `worker_transactions`.
5. **Huỷ đơn phải theo mẫu có sẵn** (xem `cancelOrder` của khách và của admin):
   - đóng lời mời đang mở với `reason = 'closed'`;
   - báo `offer:closed` cho thợ;
   - gọi `refreshAvailability(db, workerId)`, không đặt thẳng `is_busy = FALSE`;
   - gọi `notify()` sau khi COMMIT.
6. **Không sửa migration đã chạy.** Muốn đổi CSDL thì tạo migration mới: `npm run migrate:create -- ten-thay-doi`, viết SQL có cả phần `-- Down Migration`. Không đổi tên hay xoá cột mà app thợ đang dùng.
7. **Không thêm danh mục ngoài nghề điện** vào dữ liệu mẫu hay giao diện.
8. **Git:** không `push --force`, không `git reset` trên `main` hay nhánh chung. Làm trên nhánh riêng rồi mở Pull Request.
9. Không đưa `.env`, `node_modules`, `media/` hay file cá nhân (CV, ảnh giấy tờ thật) lên git.

## 3. Quy ước code của backend

- Node.js 22, **Express 5** (lỗi trong hàm async tự chuyển tới `ErrorHandler`, không cần try/catch chỉ để `next(err)`), ES module (`import`/`export`).
- **SQL thuần** bằng `pg`:
  - dùng `sql(db, text, params)` hoặc `q(text, params)` trong `src/config/db.js`;
  - hai hàm này trả BIGINT/NUMERIC về `number`. `query()` cũ trả chuỗi, chỉ dashboard cũ dùng;
  - luôn dùng tham số `$1, $2...`, không ghép chuỗi SQL từ dữ liệu người dùng.
- **Transaction:** dùng `withTransaction(fn)` (`services/customer/common.js`) hoặc `transaction((db, after) => ...)` (`utils/tx.js`). Việc cần làm *sau khi COMMIT* (thông báo, emit) đặt trong `after(...)`.
- **Lỗi:** `throw new AppError(status, 'Thông báo tiếng Việt')`. Client nhận `{ "message": "..." }` và hiển thị thẳng cho người dùng, nên viết câu tiếng Việt dễ hiểu.
- **Danh sách** trả `{ items, total, page, pageSize }`, query `?page=&pageSize=`.
- **Thời gian:** cột `TIMESTAMPTZ`, API trả ISO 8601 (UTC). App tự đổi sang giờ Việt Nam. Tính "hôm nay / tuần này" theo giờ VN (`Asia/Ho_Chi_Minh`).
- **Tiền** là số nguyên VND. **Toạ độ** là `GEOGRAPHY(POINT, 4326)`; tìm quanh một điểm thì dùng `ST_DWithin` để tận dụng chỉ mục GiST.
- **Xác thực:** admin dùng cookie (`requireAdmin`); app khách và app thợ dùng `Authorization: Bearer <JWT>` (`requireCustomer`, `requireWorker`).
- **Realtime / thông báo:**
  - `emitToUser(userId, event, payload)` (phòng `user:<id>`);
  - `notify(userId, { title, body, type, data })` lưu bảng `notifications`, đẩy `notification:new` và push;
  - `emitOrderUpdated(order)` báo cho cả khách lẫn thợ của đơn.
- **Ảnh:** client tải lên `POST /api/uploads` (multipart, trường `file`, cần đăng nhập) rồi gửi URL nhận được.
- Chú thích trong code và tên thông báo viết tiếng Việt.

## 4. Chạy, dữ liệu mẫu, kiểm thử

```bash
docker compose up -d --build       # API http://localhost:3000 (kiểm tra /api/health), CSDL localhost:5433 (thonhanh/thonhanh)
docker compose logs -f api         # xem log
docker compose down -v             # xoá sạch dữ liệu để chạy lại từ đầu
```

Không dùng Docker: `cp .env.example .env`, sửa `DATABASE_URL`, rồi `npm install`, `npm run migrate up`, `npm run seed:demo`, `npm run dev`.

- Tài khoản demo (mật khẩu `12345678`): `admin@thonhanh.vn`, `khach@thonhanh.vn` (SĐT 0912000001), `tho@thonhanh.vn`, `tho2@thonhanh.vn`, `tho.moi@thonhanh.vn` (chờ duyệt), `tho.ao01..12@thonhanh.vn` (thợ ảo).
- **Không có app thợ trong tay** mà muốn có thợ nhận đơn: `docker compose --profile bots up -d` (thợ ảo tự nhận và làm đơn). Hoặc chạy app thợ bản web (repo app thợ, cổng 8082).
- Đóng vai khách qua đúng API app khách: `docker compose exec api npm run demo:customer -- order` (các lệnh khác ghi ở đầu file `scripts/demo-customer.js`).
- **Kiểm thử bắt buộc trước khi mở PR:** `npm test` (27 nhóm, cần PostgreSQL + PostGIS ở máy; CSDL test `thonhanh_test`, đổi bằng `TEST_DATABASE_URL`). Tất cả phải đạt.

## 5. Việc cần làm theo từng người

Lý do chi tiết từng mục: `docs/TICH_HOP_THANH_VIEN_B.md` mục 4.

### Backend chung + app khách hàng

- [ ] Xoá danh mục ngoài nghề điện trong `dev-tools/seed_dev.sql`, `scripts/mockData/*.sql`. Dữ liệu mẫu chuẩn là `npm run seed:demo`.
- [ ] Bỏ trường `matching_mode` khi tạo đơn: xoá ở `controllers/customer/order.controller.js` và ở `BookScreen.tsx` của app khách. Kiểu `matching_mode` của đơn trả về chỉ là `'instant' | 'batch'`.
- [ ] Giờ hẹn phải cách hiện tại **ít nhất 60 phút** (hiện chỉ 1 phút). Có thể giới hạn khung giờ làm việc.
- [ ] Cho khách gửi **ảnh tình trạng** khi đặt đơn: tải qua `POST /api/uploads`, gửi `image_urls` khi tạo đơn, lưu vào `orders.image_urls`. App thợ đã hiển thị sẵn.
- [ ] Tài khoản khách: đăng nhập Google/Facebook, quên mật khẩu, đổi mật khẩu, đăng ký thiết bị nhận push. Có thể làm theo mẫu `services/worker/auth.service.js`, `social.js`.
- [ ] App khách: chat hiển thị ảnh (trường `image_url`); kiểu trạng thái báo giá thêm `'cancelled'`.
- [ ] Bảo hành: hiện mới tạo khiếu nại. Chốt luồng "admin duyệt → tạo đơn bảo hành 0đ cho thợ cũ" rồi báo B làm phần app thợ.
- [ ] `getOrderDetail` của khách: bỏ `refreshOffers` (đang ghi CSDL mỗi lần xem; bộ điều phối đã tự lo).
- [ ] Đổi các thông báo lỗi tiếng Anh sang tiếng Việt: các service admin ("Worker not found", "Cannot cancel..."), và `ErrorHandler` ("Already exists", "Related record not found", "Internal server error").
- [ ] Xoá thư mục `dev-tools/` (mở `/api/dev` **không cần đăng nhập** khi không phải production) cùng 2 script `seed:dev`, `simulate` trong `package.json`. Xoá file lạc `src/routes/customer/1.txt`.

### Web quản trị

- [x] Áp `docs/dashboard-che-do-ghep.patch` (trong thư mục `dashboard`: `git apply <đường dẫn>/dashboard-che-do-ghep.patch`) để chọn chế độ ghép và k. Hoặc tự làm, vì backend đã nhận `mode`, `max_offers`.
- [x] **Duyệt hồ sơ thợ theo từng giấy tờ** (hiện từ chối là từ chối cả bộ). Hiển thị `submitted_at`, xếp hồ sơ chờ duyệt theo thời gian gửi. Từ chối giấy nào thì ghi lý do cho đúng giấy đó (`worker_documents.reject_reason`); app thợ đã hiện lý do theo từng giấy.
- [x] Trang **duyệt rút tiền**: `GET /api/admin/withdrawals?status=`, `POST /api/admin/withdrawals/:id/approve`, `POST .../reject { note }` (từ chối thì tiền hoàn về ví).
- [x] Trang khiếu nại: phân biệt báo cáo do thợ gửi (`reporter_id` khác null, tiêu đề bắt đầu "[Thợ báo cáo]") với khiếu nại của khách.
- [x] Tuỳ chọn: ô trạng thái bộ điều phối (`GET /api/admin/dispatch/status`).
- [x] Xoá file CV cá nhân (PDF) trong `dashboard/src/components/matching`. Đổi placeholder "VD: Điện lạnh" thành "VD: Sửa chữa điện".
- [x] Thêm: bản đồ giám sát đơn/thợ, chuông việc cần xử lý, chi tiết đơn có ảnh trước/sau + lịch sử lời mời + vết di chuyển (API: `docs/ADMIN_API.md`).

### Điểm tin cậy (thành viên A)

- [ ] `workers.trust_score` (0..1, trọng số 0,30 khi ghép) **chưa được ai tính**; đánh giá mới chỉ cập nhật `rating_avg`. Cần cập nhật sau mỗi đánh giá, đơn hoàn thành, huỷ, khiếu nại được xác nhận.
  - Gợi ý: điểm đánh giá làm mượt Bayes, tỷ lệ hoàn thành, `workers.cancel_rate` (B đã tính sẵn), số khiếu nại đúng. Ghi lịch sử vào `trust_score_history`.
  - Lưu ý: thợ chưa có đơn, chưa có đánh giá mà `trust_score = 0` thì khi ghép đang dùng 0,5 (`TRUST_COLD_START`). Khi đã tính thật, giữ quy ước này hoặc báo B.

## 6. Trước khi mở Pull Request

- [ ] `npm test` đạt hết.
- [ ] `docker compose down -v && docker compose up -d --build` chạy được từ CSDL trống; log có `Migrations complete!` và `Server running`.
- [ ] App thợ vẫn chạy: đăng nhập `tho@thonhanh.vn`, bật nhận đơn, `npm run demo:customer -- order`, nhận đơn được.
- [ ] Không có `.env`, `node_modules`, `media/`, file cá nhân trong commit.
- [ ] Mô tả PR ghi: đã làm mục nào ở phần 5, có đụng file chung nào không, có "Đề nghị gửi B" không.
