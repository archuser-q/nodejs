# Ghi chú cho thành viên nhóm (và trợ lý AI) khi làm việc trên THỢ NHANH

> Đọc file này **trước khi sửa code**. Claude Code thường tự đọc file `CLAUDE.md` ở thư mục gốc repo. Với công cụ khác, hãy bảo trợ lý đọc file này trước.
> Repo ReactJS (app khách, app thợ, web quản trị) có `README.md` riêng ở thư mục gốc; khi làm ở đó vẫn tuân theo các quy tắc ở đây.
> **Bản đồ code (thư mục nào làm gì, tính năng nào ở file nào): `docs/KIEN_TRUC.md`.** Chi tiết lý do từng thay đổi của thành viên B: `docs/TICH_HOP_THANH_VIEN_B.md`.

## 1. Bối cảnh

THỢ NHANH là nền tảng kết nối khách hàng với **thợ điện**. Nhóm có 3 phần, dùng **chung 1 backend** (repo này) và 1 CSDL PostgreSQL/PostGIS:

| Phần | API | Người phụ trách | Tài liệu |
|---|---|---|---|
| Web quản trị (React, `ReactJS/dashboard`) | `/api/admin/...` (cookie) | thành viên nhóm | `docs/ADMIN_API.md` |
| App khách hàng (React Native, `ReactJS/thonhanh-customer-app`) | `/api/customer/...` (Bearer) | thành viên nhóm | `docs/CUSTOMER_API.md` |
| App thợ (React Native, `ReactJS/thonhanh-worker-app`) + **thuật toán ghép cặp** | `/api/worker/...` (Bearer) | **thành viên B** | `docs/WORKER_API.md`, `docs/MATCHING.md` |
| Điểm tin cậy (Trust Score) | tự cập nhật `workers.trust_score` | thành viên B (đã làm) | `src/algorithms/trust.js`, `docs/MATCHING.md` mục 7 |

Đã chốt:
- **Phạm vi chỉ gồm dịch vụ của thợ điện.** Danh mục là 4 nhóm chuyên môn: Sửa chữa điện · Lắp đặt thiết bị điện · Đồ điện gia dụng · Đi dây & tủ điện. Không thêm Nước, Điện lạnh, Khoá, Sơn...
- **Khách không chọn chế độ ghép.** Hệ thống tự ghép theo cấu hình admin đang bật, mặc định `auto` (đơn đứng riêng thì gửi ngay bằng Greedy, nhóm đơn tranh cùng thợ thì giải bằng Hungarian).
- Đăng nhập bằng email, Google hoặc Facebook (không dùng SMS OTP). Bản đồ dùng loại miễn phí. Mỗi phần chạy được bằng `docker compose up`.
- **Không nhận tiền mặt.** Khách trả qua MoMo / VNPay (sandbox) trên app khách; trả xong thì 85% vào ví thợ, thợ rút về ngân hàng. Không có nạp ví, ví thợ không âm. Khách còn đơn đã xong mà chưa trả thì chưa đặt được đơn mới.
- **Số năm kinh nghiệm của thợ là 1 con số chung** (`workers.experience_years`) cho mọi nhóm dịch vụ; `worker_skills.years` luôn bằng con số này (hàm điểm vẫn đọc cột đó).
- **Thợ chưa được duyệt vẫn vào được app** nhưng không bật nhận đơn được. Admin từ chối / bỏ duyệt thì thợ bị tắt nhận đơn ngay.
- **Mật khẩu tài khoản thợ:** 8–72 ký tự, có cả chữ và số, chặn mật khẩu quá phổ biến (`password()` trong `src/utils/validate.js`). Không bắt chữ hoa / ký tự đặc biệt (theo NIST SP 800-63B).

## 2. Những điều KHÔNG được làm

1. **Không sửa phần của thành viên B** khi chưa trao đổi:
   - các thư mục `src/algorithms/`, `src/services/matching/`, `src/services/trust/`, `src/services/worker/`, `src/controllers/worker/`, `src/routes/worker/`;
   - các file `src/routes/upload.routes.js`, `src/routes/admin/dispatch.routes.js`, `migrations/1792200000000_worker-app-matching.sql`;
   - các đoạn có đánh dấu `[B]` trong file chung.

   Nếu thấy cần đổi, ghi vào mô tả Pull Request mục "Đề nghị gửi B" để B sửa.
2. **Không đổi API app thợ** (`/api/worker`, xem `docs/WORKER_API.md`) và các sự kiện Socket.IO (`offer:new`, `offer:closed`, `order:updated`, `message:new`, `notification:new`, `worker:location`). App thợ đang dùng đúng tên trường và định dạng hiện tại.
3. **Không gửi lời mời (offer) cho thợ trực tiếp.** Đơn mới chỉ cần gọi `dispatchOffers(orderId)` (`src/services/customer/dispatch.service.js`) sau khi đơn đã lưu; bộ điều phối lo phần còn lại. Không ghi thẳng vào `order_offers` / `order_dispatches`.
4. **Không tự cộng/trừ ví thợ.** Mọi thanh toán thành công phải đi qua `settlePayment()` (`src/services/customer/interaction.service.js`). Hàm này gọi `recordPaidOrder()` để cộng phần thực nhận (tổng tiền − 15 %) vào ví thợ, có chống ghi trùng. Không sửa trực tiếp `workers.wallet_balance` hay `worker_transactions`. Không thêm lại phương thức `cash`.
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
- **Chia tầng:** `routes` (khai báo đường dẫn) → `controllers` (kiểm tra dữ liệu vào, không có SQL) → `services` (nghiệp vụ + SQL) → `algorithms` (tính toán thuần, không đụng CSDL). Tham số nghiệp vụ có mặc định đọc từ `src/config/settings.js`.
- **Transaction:** dùng `withTransaction(fn)` (`services/customer/common.js`) hoặc `transaction((db, after) => ...)` (`utils/tx.js`). Việc cần làm *sau khi COMMIT* (thông báo, emit) đặt trong `after(...)`.
- **Lỗi:** `throw new AppError(status, 'Thông báo tiếng Việt')`. Client nhận `{ "message": "..." }` và hiển thị thẳng cho người dùng, nên viết câu tiếng Việt dễ hiểu.
- **Danh sách** trả `{ items, total, page, pageSize }`, query `?page=&pageSize=`.
- **Thời gian:** cột `TIMESTAMPTZ`, API trả ISO 8601 (UTC). App tự đổi sang giờ Việt Nam. Tính "hôm nay / tuần này" theo giờ VN (`Asia/Ho_Chi_Minh`).
- **Tiền** là số nguyên VND. **Toạ độ** là `GEOGRAPHY(POINT, 4326)`; tìm quanh một điểm thì dùng `ST_DWithin` để tận dụng chỉ mục GiST.
- **Xác thực:** admin dùng cookie (`requireAdmin`); app khách và app thợ dùng `Authorization: Bearer <JWT>` (`requireCustomer`, `requireWorker`).
- **Realtime / thông báo:**
  - `emitToUser(userId, event, payload)` (phòng `user:<id>`, `src/realtime/socket.js`);
  - `notify(userId, { title, body, type, data })` (`src/services/shared/notify.service.js`) lưu bảng `notifications`, đẩy `notification:new` và push;
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
- **Không có app thợ trong tay** mà muốn có thợ nhận đơn: `docker compose --profile bots up -d` (thợ ảo tự nhận và làm đơn). Hoặc chạy app thợ (`ReactJS/thonhanh-worker-app`).
- Đóng vai khách qua đúng API app khách: `docker compose exec api npm run demo:customer -- order` (các lệnh khác ghi ở đầu file `scripts/demo-customer.js`).
- **Kiểm thử bắt buộc trước khi mở PR:** `npm test` (42 bài, cần PostgreSQL + PostGIS ở máy; CSDL test `thonhanh_test`, đổi bằng `TEST_DATABASE_URL`). Tất cả phải đạt.

## 5. Tình trạng các việc đã giao khi gộp code

Lý do chi tiết từng mục: `docs/TICH_HOP_THANH_VIEN_B.md` mục 4. Bản gộp ngày 26/10 đã kiểm tra lại từng mục.

### Backend chung + app khách hàng

- [x] Xoá danh mục ngoài nghề điện: đã xoá hẳn `dev-tools/`, `scripts/mockData/`. Dữ liệu mẫu chuẩn là `npm run seed:demo`.
- [x] Bỏ `matching_mode` khi tạo đơn (backend bỏ qua nếu client gửi lên; kiểu trả về chỉ `'instant' | 'batch'`).
- [x] Giờ hẹn cách hiện tại ít nhất 60 phút, chỉ nhận 7:00–21:00, tối đa 30 ngày.
- [x] Ảnh tình trạng khi đặt đơn (`image_urls`).
- [x] Tài khoản khách: Google/Facebook, quên / đổi mật khẩu, đăng ký thiết bị nhận push; mật khẩu dùng chung `password()`.
- [x] App khách: chat có ảnh, báo giá có trạng thái `'cancelled'`, bỏ "Tiền mặt", bị chặn vì đơn chưa trả thì đưa tới đơn đó.
- [x] `getOrderDetail` không còn ghi CSDL mỗi lần xem.
- [x] Thông báo lỗi của các service đã là tiếng Việt. Riêng 5 câu tiếng Anh chung trong `middlewares/ErrorHandler.js` ("Already exists"...) được 2 app tự dịch (`src/api/client.ts`), nên giữ nguyên để không lệch với app.
- [x] Xoá `dev-tools/` (từng mở `/api/dev` không cần đăng nhập), script `seed:dev`, `simulate`, các file `1.txt`.
- [ ] **Bảo hành** hiện là khiếu nại loại `warranty` do khách gửi trong thời hạn, admin xử lý ở trang Khiếu nại. Chưa có bước "admin duyệt → tạo đơn bảo hành 0đ giao lại thợ cũ" (hướng phát triển).

### Web quản trị

- [x] Chọn chế độ ghép và k; trạng thái bộ điều phối.
- [x] Duyệt hồ sơ thợ theo từng giấy tờ, xếp theo `submitted_at`, lý do từ chối theo từng giấy.
- [x] Duyệt rút tiền (`/api/admin/withdrawals`). Mặc định mọi lệnh rút chờ admin duyệt (`WITHDRAWAL_AUTO_APPROVE=false`).
- [x] Phân biệt báo cáo do thợ gửi với khiếu nại của khách.
- [x] Bản đồ giám sát, chuông việc cần xử lý, chi tiết đơn (ảnh trước/sau, lịch sử lời mời, vết di chuyển).

### Điểm tin cậy

- [x] Đã làm (thành viên B): `src/algorithms/trust.js` (công thức) + `src/services/trust/trust.service.js` (lấy dữ liệu, lưu `trust_score_history`).
  - `trust = 0,5 · đánh giá làm mượt Bayes + 0,3 · giữ lời (hoàn thành / huỷ sau khi nhận) + 0,2 · khiếu nại đúng của khách`.
  - Tự tính lại sau mỗi đánh giá, đơn hoàn thành, thợ huỷ đơn đã nhận, admin xử lý xong khiếu nại của khách. Đổi tham số thì chạy `npm run trust:recalc`.
  - Thợ chưa có lịch sử giữ `trust_score = 0`, khi ghép dùng mức trung tính 0,5 (`TRUST_COLD_START`).
  - **Không cập nhật `workers.trust_score` bằng tay** ở chỗ khác; sự kiện mới ảnh hưởng độ tin cậy thì gọi `recalcTrustScore(db, workerId, lyDo)` trong cùng transaction.

## 6. Trước khi mở Pull Request

- [ ] `npm test` đạt hết.
- [ ] `docker compose down -v && docker compose up -d --build` chạy được từ CSDL trống; log có `Migrations complete!` và `Server running`.
- [ ] App thợ vẫn chạy: đăng nhập `tho@thonhanh.vn`, bật nhận đơn, `npm run demo:customer -- order`, nhận đơn được.
- [ ] Không có `.env`, `node_modules`, `media/`, file cá nhân trong commit.
- [ ] Mô tả PR ghi: đã làm mục nào ở phần 5, có đụng file chung nào không, có "Đề nghị gửi B" không.
