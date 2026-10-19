# Ghép code phần thành viên B (App thợ + ghép cặp) vào backend chung

Tài liệu dành cho cả nhóm khi gộp 3 phần thành một hệ thống. Nội dung gồm:
- phần B thêm gì, sửa gì trong code chung;
- những chỗ 2 bạn còn lại cần sửa hoặc bổ sung để khớp với nhau và đúng thực tế.

Bản tóm tắt dạng danh sách việc + các quy tắc khi sửa code: `CLAUDE.md` ở thư mục gốc.

## 1. Phạm vi đã thống nhất

- **Chỉ dịch vụ của thợ điện.** Danh mục là các nhóm chuyên môn trong nghề điện:
  - Sửa chữa điện
  - Lắp đặt thiết bị điện
  - Đồ điện gia dụng
  - Đi dây & tủ điện

  Không có Nước, Điện lạnh, Khoá - cửa, Sơn - chống thấm. Code không gắn cứng tên danh mục; phạm vi do dữ liệu danh mục quyết định.
- **Khách không chọn chế độ ghép.** Hệ thống tự quyết theo cấu hình admin đang bật, mặc định là `auto` (xem `docs/MATCHING.md`).
- App thợ v2.0.0 chỉ chạy với backend Node này: cổng 3000, đường dẫn `/api/worker`.

## 2. Phần B thêm mới (không đụng code của bạn khác)

| Nhóm | File |
|---|---|
| Migration | `migrations/1792200000000_worker-app-matching.sql` (có `down`) |
| Thuật toán | `src/matching/` (Hungarian, Greedy, Union-Find, xếp hạng) |
| Bộ điều phối | `src/services/matching/` (hàng đợi, Greedy / Hungarian / auto, vòng chạy nền, tỷ lệ nhận đơn) |
| API app thợ | `src/routes/worker/`, `src/controllers/worker/`, `src/services/worker/`, `src/middlewares/requireWorker.js` |
| Dùng chung | `src/routes/upload.routes.js` (`POST /api/uploads`, `/media`), `src/services/mail.service.js`, `src/services/push.service.js` |
| Admin | `src/routes/admin/dispatch.routes.js` (trạng thái điều phối, đổi chế độ, duyệt rút tiền) |
| Tiện ích | `src/config/worker.js`, `src/utils/{tx,validate,vn}.js` |
| Script / test | `scripts/` (seed demo, thợ ảo, khách giả lập, benchmark, khởi động Docker), `test/` |
| Docker | `Dockerfile`, `docker-compose.yml`, `.dockerignore` |

**Migration thêm:**
- Giá trị enum: `offer_status.cancelled`, `quote_status.cancelled`, `wallet_txn_type.topup`.
- Cột: `workers.submitted_at`, `orders.safety_checked_at`, `order_offers.round/reason`, `matching_configs.mode/max_offers`, `worker_transactions.withdrawal_id`, `complaints.reporter_id`.
- Bảng: `worker_bank_accounts`, `password_reset_codes`, `order_photos`, `order_dispatches`, `worker_withdrawals`, `worker_location_logs`.

Migration không đổi hay xoá cột nào có sẵn.

## 3. File chung đã sửa

Mọi chỗ sửa trong các file dưới đây đều có đánh dấu `[B]`. Khi gộp code, giữ nguyên các chỗ này.

| File | Sửa gì, vì sao |
|---|---|
| `migrations/1792036223715_init-schema.sql` | `CREATE EXTENSION IF NOT EXISTS postgis`: image Docker `postgis/postgis` tạo sẵn extension trong CSDL nên bản cũ báo lỗi "extension already exists" và không tạo được bảng nào |
| `src/app.js` | gắn `/api/worker`, `/api/uploads`, `/media`, `/api/health`; `CORS_ORIGIN_REGEX` cho bản web của app trên IP LAN |
| `src/server.js` | bật bộ điều phối chạy nền; tắt gọn khi nhận SIGTERM |
| `src/services/customer/dispatch.service.js` | thành lớp chuyển tiếp: `dispatchOffers` / `refreshOffers` gọi bộ điều phối của B (bản cũ gửi offer trực tiếp, không có hết hạn hay mời lại) |
| `src/services/customer/interaction.service.js` | `settlePayment` gọi `recordPaidOrder` (ví thợ, hoa hồng 15 %, chống cộng trùng); chat nhận thêm `image_url`; khách không thấy báo cáo do thợ gửi |
| `src/services/customer/notify.service.js` | gửi thêm thông báo đẩy (Expo, tắt mặc định) |
| `src/services/customer/order.service.js` | khi khách huỷ: đóng lời mời với `reason='closed'`, báo `offer:closed` cho app thợ, tính lại cờ bận thay vì đặt thẳng `FALSE` |
| `src/services/order.service.js` (admin huỷ đơn) | trước đây không báo cho ai: thợ đang trên đường không biết đơn đã huỷ. Nay báo cho khách và thợ, đóng lời mời, tính lại cờ bận |
| `src/services/candidate.js` | thêm tuỳ chọn `includeBusy` (đơn hẹn giờ), `db` (chạy trong transaction); trả thêm bán kính nhận việc và thời điểm cập nhật vị trí; thợ mới dùng điểm tin cậy trung tính 0,5 |
| `src/services/matching.service.js`, `src/controllers/admin/matching.controller.js` | form cấu hình nhận thêm `mode`, `max_offers` (không gửi thì giữ nguyên, nên web quản trị cũ vẫn chạy) |
| `src/controllers/admin/worker.controller.js` | duyệt / từ chối hồ sơ xong thì báo cho thợ |
| `src/routes/admin/index.js` | gắn `/admin/dispatch`, `/admin/withdrawals` |
| `package.json`, `.env.example`, `.gitignore` | thư viện `multer`, `nodemailer`; script demo / test; biến môi trường mới |

## 4. Việc cần các bạn làm khi ghép

### Backend chung và app khách hàng

1. **Dữ liệu mẫu ngoài phạm vi:** xoá các danh mục Nước, Điện lạnh, Đồ gia dụng, Khoá - cửa, Sơn - chống thấm trong `dev-tools/seed_dev.sql` và `scripts/mockData/*.sql`. Dữ liệu mẫu chuẩn là `npm run seed:demo`.
2. **Bỏ `matching_mode` khi tạo đơn.** Backend đang kiểm tra trường này nhưng không dùng (hệ thống tự chọn). App khách đang gửi cứng `'instant'` ở `BookScreen.tsx`, cần xoá. Kiểu `matching_mode` của đơn trả về chỉ là `'instant' | 'batch'` (chế độ thực tế đã dùng).
3. **Giờ hẹn quá sát.** Hiện cho hẹn sau 1 phút. Nên yêu cầu ít nhất 60 phút. Đơn cần ngay thì đặt "làm ngay". Hệ thống chỉ tìm thợ cho đơn hẹn tới 15 phút trước giờ hẹn. Có thể giới hạn thêm khung giờ làm việc (ví dụ 7:00–21:00).
4. **Ảnh tình trạng khi đặt đơn.** Cột `orders.image_urls` đã có nhưng app khách chưa gửi. Thợ điện rất cần ảnh để biết trước phải mang gì. Cách làm: tải ảnh qua `POST /api/uploads` rồi gửi `image_urls` khi tạo đơn. App thợ đã hiển thị sẵn.
5. **Tài khoản khách còn thiếu** đăng nhập Google / Facebook, quên mật khẩu, đổi mật khẩu, đăng ký thiết bị nhận thông báo đẩy. Phía thợ đã có đủ (`services/worker/auth.service.js`, `social.js`, `/device-tokens`), có thể làm theo cùng cách.
6. **App khách:** chat cần hiển thị ảnh (hiện chỉ ghi "[Hình ảnh]"); kiểu trạng thái báo giá cần thêm `'cancelled'` (thợ rút báo giá).
7. **Bảo hành mới dừng ở mức tạo khiếu nại.** Thực tế cần: admin duyệt → tạo đơn bảo hành 0đ giao lại cho đúng thợ cũ, hoặc tìm thợ khác nếu thợ cũ nghỉ. Phía B sẵn sàng làm phần app thợ khi chốt luồng.
8. **`getOrderDetail` của khách đang ghi CSDL mỗi lần xem** (`refreshOffers`). Có thể bỏ, vì bộ điều phối đã tự nhận các đơn chưa vào hàng đợi.
9. **Thông báo lỗi trong service admin đang là tiếng Anh** ("Worker not found", "Cannot cancel..."). Nên đổi sang tiếng Việt cho đồng bộ.
10. **`dev-tools/` mở `/api/dev` không cần đăng nhập** khi `NODE_ENV` khác production: ai trong mạng LAN cũng nhận và hoàn thành đơn được. Đã có app thợ và thợ ảo thay thế nên nên xoá thư mục này khi gộp. Image Docker đã loại thư mục này.

### Web quản trị

1. **Chế độ ghép và k:** áp file gợi ý `docs/dashboard-che-do-ghep.patch` (vào thư mục `dashboard`: `git apply <đường dẫn>/dashboard-che-do-ghep.patch`) hoặc tự làm. Backend đã nhận `mode`, `max_offers`.
2. **Duyệt hồ sơ thợ theo từng giấy tờ.** Hiện từ chối là từ chối toàn bộ giấy tờ, kể cả giấy hợp lệ, nên thợ phải tải lại hết. Nên hiển thị `submitted_at` và xếp hồ sơ chờ duyệt theo thời gian gửi.
3. **Trang duyệt rút tiền** của thợ (API có sẵn: `GET /api/admin/withdrawals`, `.../approve`, `.../reject`). Trang này cần khi tắt `WITHDRAWAL_AUTO_APPROVE`.
4. **Khiếu nại:** phân biệt báo cáo do thợ gửi (`reporter_id` khác null, tiêu đề bắt đầu bằng "[Thợ báo cáo]") với khiếu nại của khách.
5. **Tuỳ chọn:** ô trạng thái bộ điều phối (`GET /api/admin/dispatch/status`).
6. Xoá file CV cá nhân (PDF) đang nằm trong `dashboard/src/components/matching`.
7. Placeholder "VD: Điện lạnh" ở form danh mục nên đổi thành "VD: Sửa chữa điện".

### Điểm tin cậy (Trust Score)

`workers.trust_score` (trọng số 0,30 trong hàm điểm ghép cặp) **chưa được ai tính**. Đánh giá mới chỉ cập nhật `rating_avg`. Hiện chỉ dữ liệu seed có giá trị; thợ mới dùng mức trung tính 0,5 khi ghép.

Người phụ trách Trust Score cần cập nhật `trust_score` (0..1) sau mỗi đánh giá, hoàn thành, huỷ và khiếu nại được xác nhận. Gợi ý các thành phần:
- điểm đánh giá đã làm mượt Bayes (tránh 1 đánh giá 5★ thành điểm tuyệt đối);
- tỷ lệ hoàn thành, tỷ lệ huỷ (có sẵn `workers.cancel_rate`);
- số khiếu nại đúng.

## 5. Biến môi trường mới

Tất cả đều có mặc định, xem `.env.example`. Hay dùng:
- `PUBLIC_BASE_URL`
- `CORS_ORIGIN_REGEX`
- `LOCATION_MAX_AGE_MINUTES`
- `DISPATCH_MAX_WAIT_MINUTES`
- `COMMISSION_RATE`
- `WALLET_DEBT_LIMIT`
- `WITHDRAWAL_AUTO_APPROVE`
- `TRUST_COLD_START`
- `GOOGLE_*` / `FACEBOOK_*` / `SMTP_*`

## 6. Đẩy code lên GitHub (không ghi đè nhánh chung)

```bash
git clone <repo backend của nhóm> && cd <thư mục repo>
git checkout <nhánh chung của nhóm, VD dev-q> && git pull
git checkout -b feature/worker-app-matching
# chép toàn bộ nội dung thư mục backend-node đè lên (TRỪ .git, node_modules, .env, media)
git add -A
git status                      # xem lại: không có .env, node_modules, media
git commit -m "Thanh vien B: API app tho, module ghep cap, Docker, kiem thu"
git push -u origin feature/worker-app-matching
```

Sau đó mở Pull Request vào nhánh chung trên GitHub để cả nhóm xem trước khi gộp.
- Code này đã gộp sẵn `feature/customer-api`. Nếu nhánh chung chưa có phần đó, PR sẽ kèm cả code app khách. Nên gộp `feature/customer-api` trước.
- Không `push --force`, không `git reset` trên `main` hay nhánh chung.
