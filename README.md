# THỢ NHANH — Backend (Node.js)

THỢ NHANH là nền tảng kết nối khách hàng với **thợ điện** (sửa chữa điện, lắp đặt thiết bị điện, đồ điện gia dụng, đi dây & tủ điện).
Một backend dùng chung cho 3 phần:

| Phần | Đường dẫn API | Người phụ trách |
|---|---|---|
| Web quản trị | `/api/admin/...` (cookie) | thành viên nhóm |
| App khách hàng | `/api/customer/...` (Bearer) — `docs/CUSTOMER_API.md` | thành viên nhóm |
| App thợ + **ghép cặp thợ – đơn** | `/api/worker/...` (Bearer) — `docs/WORKER_API.md`, `docs/MATCHING.md` | thành viên B |

Công nghệ: Node.js 22 · Express 5 · PostgreSQL 16 + PostGIS · Socket.IO · node-pg-migrate (SQL thuần) · Docker Compose.

## Chạy bằng Docker (khuyên dùng)

Chỉ cần Docker Desktop. Không cần file `.env`, vì mọi biến đều có giá trị mặc định cho demo.

```bash
docker compose up -d --build          # lần đầu khoảng 1–2 phút
docker compose logs -f api            # xem log; thấy "Server running" và "[dispatcher] ... leader" là xong
```

- API: http://localhost:3000. Kiểm tra bằng http://localhost:3000/api/health, kết quả phải là `{"status":"ok"}`.
- CSDL: `localhost:5433`, user / mật khẩu / database đều là `thonhanh` (mở bằng pgAdmin hoặc DBeaver).
- Khi khởi động, container tự chạy migration, nạp dữ liệu demo (`SEED_DEMO=true`, chạy lại không tạo trùng) rồi bật server. Bộ điều phối ghép cặp chạy nền ngay trong API.

Lệnh hay dùng:

```bash
docker compose --profile bots up -d                         # bật 8 "thợ ảo" tự nhận đơn, tự làm tới khi xong
docker compose exec api npm run demo:customer -- order      # đóng vai khách: đặt 1 đơn cách thợ demo ~700 m
docker compose exec api npm run demo:customer -- rush --count 10   # 10 đơn cùng lúc (thấy Hungarian chạy)
docker compose down                                         # dừng (giữ dữ liệu)
docker compose down -v                                      # dừng và XOÁ dữ liệu (seed lại từ đầu lần sau)
```

> Nếu máy đang chạy bản backend FastAPI cũ: vào thư mục cũ, chạy `docker compose down` trước. Lý do: cổng 3000 / 5433 có thể đang bị chiếm, và app thợ v2 chỉ nói chuyện với backend Node này.

## Tài khoản demo

Mật khẩu chung: `12345678` (chỉ dữ liệu demo; tài khoản thợ đăng ký mới cần mật khẩu ≥ 8 ký tự, có cả chữ và số).

Thanh toán: **chỉ MoMo / VNPay** (sandbox), không có tiền mặt. Khách trả xong thì 85% vào ví thợ, thợ rút về ngân hàng.

| Tài khoản | Vai trò |
|---|---|
| `tho@thonhanh.vn` | thợ đã duyệt (Trần Minh Đức), có sẵn lịch sử 6 tuần: thu nhập, ví, đánh giá, một lịch hẹn sáng mai |
| `tho2@thonhanh.vn` | thợ đã duyệt thứ 2, dùng để demo 2 thợ tranh đơn |
| `tho.moi@thonhanh.vn` | thợ vừa gửi hồ sơ, đang chờ admin duyệt |
| `khach@thonhanh.vn` (SĐT `0912000001`) | khách hàng, có địa chỉ gần Hồ Gươm |
| `admin@thonhanh.vn` | quản trị |
| `tho.ao01..12@thonhanh.vn` | thợ ảo cho script bot |

## Chạy không dùng Docker

Cần Node 22 và PostgreSQL 16 có PostGIS.

```bash
cp .env.example .env          # sửa DATABASE_URL, JWT_SECRET
npm install
npm run migrate up            # tạo bảng
npm run seed:demo             # dữ liệu demo (tuỳ chọn)
npm run dev                   # http://localhost:3000
```

Điện thoại thật hoặc máy khác trong cùng Wi-Fi:
- app dùng `http://<IP LAN của máy>:3000`;
- đặt `PUBLIC_BASE_URL=http://<IP LAN>:3000` để đường dẫn ảnh đúng;
- trên Windows, mở cổng 3000 trong tường lửa cho mạng **Private**.

## Script demo và kiểm thử

| Lệnh | Việc |
|---|---|
| `npm run bots -- --count 8 --accept 0.85` | thợ ảo: đăng nhập, nhận / từ chối lời mời, di chuyển, chụp ảnh, hoàn thành (qua đúng API app thợ) |
| `npm run demo:customer -- order \| quote \| pay \| review \| cancel \| show \| rush` | khách giả lập qua đúng API app khách (xem đầu file `scripts/demo-customer.js`). `pay` trả qua MoMo / VNPay sandbox; `rush` tự trả các đơn còn nợ trước khi đặt |
| `npm test` | 27 bài kiểm thử tích hợp trên PostGIS thật (CSDL `thonhanh_test`, đổi bằng `TEST_DATABASE_URL`) |
| `npm run test:algo` | kiểm chứng thuật toán: Hungarian so với vét cạn, Greedy, Union-Find (không cần CSDL) |
| `npm run benchmark -- --out ket-qua` | thực nghiệm so sánh các chế độ ghép (khoảng 15 giây). Kết quả đã chạy nằm trong `docs/thuc-nghiem/` |

## Cấu trúc

```
migrations/                  SQL: schema của nhóm + 1792200000000_worker-app-matching.sql (phần thành viên B)
src/
  app.js, server.js          Express + Socket.IO (+ bật bộ điều phối)
  routes/ controllers/       admin/, customer/, worker/ (B), upload.routes.js (B, dùng chung)
  services/
    customer/                app khách
    worker/                  app thợ (B): tài khoản, hồ sơ, đơn, thu nhập, ví
    matching/                bộ điều phối ghép cặp (B)
    candidate.js, scoring.js lọc không gian + hàm điểm (dùng chung với trang Mô phỏng của admin)
  matching/                  thuật toán thuần (B): hungarian.js, greedy.js, grouping.js
scripts/                     seed demo, thợ ảo, khách giả lập, benchmark, khởi động Docker
test/                        kiểm thử (node:test)
docs/                        CUSTOMER_API, WORKER_API, MATCHING, TICH_HOP_THANH_VIEN_B, HUONG_DAN_GOOGLE_FACEBOOK, thuc-nghiem/
dev-tools/                   công cụ giả lập thợ cũ của app khách (không đưa vào image Docker)
```

**Thành viên nhóm (và trợ lý AI) đọc `CLAUDE.md` trước khi sửa code**: phạm vi, những điều không được làm, quy ước code, việc cần làm của từng người.

Trong file dùng chung của nhóm, mọi chỗ thành viên B sửa đều có đánh dấu `[B]`. Danh sách đầy đủ và các việc cần 2 bạn còn lại làm khi ghép code nằm trong `docs/TICH_HOP_THANH_VIEN_B.md`.

## Gặp lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `port is already allocated` | cổng 3000 / 5433 đang bận: tắt backend cũ, hoặc đổi `API_PORT=3001` / `DB_PORT=5434` khi chạy compose |
| Thợ bật nhận đơn nhưng không nhận được lời mời | app phải gửi vị trí: vị trí cũ hơn 10 phút thì không được ghép (`LOCATION_MAX_AGE_MINUTES`). Ngoài ra kiểm tra thợ đã được duyệt hồ sơ, đã chọn đúng nhóm dịch vụ, và đơn nằm trong bán kính nhận việc |
| Đơn đặt ngay tự huỷ | không ai nhận trong 15 phút (`DISPATCH_MAX_WAIT_MINUTES`) |
| Khách đặt đơn bị báo "chưa thanh toán đơn..." | nền tảng không nhận tiền mặt: khách phải trả đơn đã xong (MoMo / VNPay) rồi mới đặt đơn mới. Demo: `npm run demo:customer -- pay <mã đơn>` |
| Ảnh không hiện trên điện thoại | đặt `PUBLIC_BASE_URL=http://<IP LAN>:3000` rồi `docker compose up -d` |
| Nút Google / Facebook trên app mờ | chưa đăng ký mã ứng dụng: làm theo `docs/HUONG_DAN_GOOGLE_FACEBOOK.md` |
| Quên mật khẩu không thấy email | chưa cấu hình `SMTP_*`: ngoài production, mã 6 số hiện ngay trên app và trong log API |
| Muốn dữ liệu demo mới tinh | `docker compose down -v` rồi `docker compose up -d --build` |
