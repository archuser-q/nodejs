# Kiến trúc THỢ NHANH — đọc code từ đâu

Tài liệu này giúp cả nhóm đọc lại code để bảo vệ và vấn đáp: thư mục nào làm gì, một yêu cầu đi qua những file nào, tính năng X nằm ở đâu. Chi tiết API: `CUSTOMER_API.md`, `WORKER_API.md`, `ADMIN_API.md`. Chi tiết thuật toán ghép cặp: `MATCHING.md`.

## 1. Toàn cảnh

```
 App khách (Expo)        App thợ (Expo)         Web quản trị (React + Vite)
 thonhanh-customer-app   thonhanh-worker-app    dashboard
        │ Bearer JWT            │ Bearer JWT            │ cookie httpOnly
        ▼                       ▼                       ▼
 /api/customer/...       /api/worker/...        /api/admin/...      ← 1 backend Node.js (repo này)
        └──────── Socket.IO (cùng cổng 3000, phòng "user:<id>") ─────┘
                                 │
                     PostgreSQL 16 + PostGIS (1 CSDL dùng chung)
```

- **3 app, 1 backend, 1 CSDL.** Hai app di động gọi API bằng `Authorization: Bearer <JWT>`; web quản trị đăng nhập bằng cookie và gọi qua proxy cùng origin (`/api`).
- **Realtime**: server đẩy sự kiện vào phòng riêng của từng người (`user:<id>`), app nghe để tải lại đúng phần dữ liệu liên quan (bảng ở mục 5).
- **Bộ điều phối ghép cặp** chạy nền ngay trong tiến trình API (`services/matching/dispatcher.js`), mỗi 2 giây xử lý hàng đợi đơn đang tìm thợ.

## 2. Cấu trúc thư mục backend

```
src/
  server.js                 khởi động HTTP + Socket.IO + bộ điều phối chạy nền
  app.js                    Express: CORS, gắn router /api/admin, /api/customer, /api/worker, /api/uploads, /media
  config/
    env.js                  biến môi trường bắt buộc (DB, JWT...)
    db.js                   pool PostgreSQL; sql()/q() trả số thay vì chuỗi cho BIGINT/NUMERIC
    settings.js             tham số nghiệp vụ có mặc định: hoa hồng, rút tiền, điều phối, đăng nhập Google/Facebook, SMTP
  middlewares/              requireAdmin (cookie) · requireCustomer / requireWorker (Bearer JWT) · ErrorHandler
  realtime/socket.js        Socket.IO: xác thực token, phòng user:<id>, emitToUser()
  routes/                   chỉ khai báo đường dẫn → controller
    admin/  customer/  worker/  upload.routes.js
  controllers/              đọc & kiểm tra dữ liệu vào (req) → gọi service → trả JSON
    admin/  customer/  worker/
  services/                 nghiệp vụ + SQL
    admin/                  web quản trị: thợ, khách, đơn, danh mục, khiếu nại, tài chính, bản đồ giám sát, báo cáo, cấu hình ghép
    customer/               app khách: tài khoản, đặt / huỷ đơn, chat, thanh toán, đánh giá, khiếu nại, bảo hành
    worker/                 app thợ: tài khoản, hồ sơ & giấy tờ, nhận / làm đơn, thu nhập, ví, rút tiền
    matching/               bộ điều phối ghép cặp: lọc ứng viên (candidate.js), hàng đợi + gửi lời mời (dispatch.service.js),
                            vòng chạy nền (dispatcher.js), tỷ lệ nhận đơn (stats.js), cấu hình đang bật (config.js)
    trust/                  điểm tin cậy: lấy dữ liệu, tính, lưu lịch sử (trust.service.js)
    shared/                 dùng chung 3 phía: thông báo (notify.service.js), email (mail), thông báo đẩy Expo (push)
  algorithms/               THUẬT TOÁN THUẦN — không đụng CSDL, kiểm thử độc lập (test/algorithms.test.js)
    scoring.js              hàm điểm Weighted Scoring 5 tiêu chí + xếp hạng
    greedy.js               Greedy top-k (chế độ tức thời)
    hungarian.js            Hungarian / Kuhn–Munkres (chế độ theo lô)
    grouping.js             Union-Find: tách các nhóm đơn tranh cùng thợ (chế độ tự động)
    trust.js                công thức điểm tin cậy
  utils/                    AppError, JWT, cookie, transaction (tx.js), kiểm tra dữ liệu vào (validate.js), giờ VN & tiền (vn.js)
migrations/                 SQL (node-pg-migrate), chạy theo thứ tự tên file; không sửa file đã chạy, muốn đổi thì thêm file mới
scripts/                    seed-demo (dữ liệu demo) · worker-bots (thợ ảo) · demo-customer (khách giả lập) ·
                            benchmark-matching (thực nghiệm) · recalc-trust · create-admin · docker-start
test/                       kiểm thử tích hợp trên PostgreSQL thật (mục 7)
docs/                       tài liệu (file này, API, ghép cặp, thực nghiệm)
```

**Quy tắc chia tầng** (giống nhau cho cả 3 phía): `routes` chỉ khai báo đường dẫn → `controllers` kiểm tra dữ liệu vào, không có SQL → `services` làm nghiệp vụ và SQL → `algorithms` chỉ có tính toán thuần. Lỗi nghiệp vụ ném `AppError(status, 'câu tiếng Việt')`, `ErrorHandler` trả `{ message }` cho app hiển thị thẳng.

## 3. Một yêu cầu đi qua những file nào (ví dụ "khách đặt đơn")

| Bước | File | Việc |
|---|---|---|
| 1 | `routes/customer/index.js` | `POST /orders` → `requireCustomer` → `order.create` |
| 2 | `controllers/customer/order.controller.js` → `create` | kiểm tra dịch vụ, địa chỉ, giờ hẹn (≥ 60 phút, 7:00–21:00), ảnh, có SĐT |
| 3 | `services/customer/order.service.js` → `createOrder` | chặn nếu còn đơn chưa thanh toán, lưu đơn trạng thái `matching` (transaction) |
| 4 | `services/customer/dispatch.service.js` → `dispatchOffers` | điểm nối sang bộ điều phối: đưa đơn vào hàng đợi |
| 5 | `services/matching/dispatch.service.js` | lọc ứng viên (`matching/candidate.js`, PostGIS) → chấm điểm (`algorithms/scoring.js`) → Greedy / Hungarian → ghi `order_offers` |
| 6 | `realtime/socket.js` + `shared/notify.service.js` | đẩy `offer:new` + thông báo cho thợ được mời |
| 7 | App thợ `src/screens/home/OfferCenter.tsx` | hiện lời mời toàn màn hình, đếm ngược; thợ bấm Nhận → `POST /api/worker/offers/:id/accept` |

## 4. Các luồng nghiệp vụ chính và file tương ứng

| Luồng | Backend | App / web |
|---|---|---|
| Đăng ký, đăng nhập (email, Google, Facebook), quên mật khẩu | `services/worker/auth.service.js`, `social.js`; `services/customer/auth.service.js`; `services/admin/auth.service.js` | app thợ `screens/auth/`, app khách `LoginScreen.tsx`, web `routes/login.tsx` |
| Thợ hoàn thiện hồ sơ, nộp giấy tờ | `services/worker/profile.service.js` (onboarding, giấy tờ, `review_state`, `blockers`) | app thợ `screens/onboarding/`, `screens/account/DocumentsScreen.tsx` |
| Admin duyệt từng giấy / cả hồ sơ, bỏ duyệt | `services/admin/worker.service.js` (`reviewDocument`, `reviewWorker`), `controllers/admin/worker.controller.js` | web `components/workers/DocumentReview.tsx`, `WorkerDetailDrawer.tsx` |
| Bật nhận đơn, gửi vị trí | `services/worker/profile.service.js` (`setAvailability`, `updateLocation`) | app thợ `screens/home/HomeScreen.tsx`, `hooks/useLocation.ts` |
| Ghép cặp: hàng đợi, lời mời, hết giờ, mời đợt sau, huỷ đơn quá hạn | `services/matching/*`, `algorithms/*` | web `routes/_admin/matching.tsx` (cấu hình, mô phỏng, trạng thái) |
| Làm đơn: đi → đến → kiểm tra an toàn → sửa → ảnh → hoàn thành | `services/worker/job.service.js` (`advanceStatus`, ảnh, báo giá phát sinh) | app thợ `screens/jobs/JobDetailScreen.tsx`; app khách `TrackScreen.tsx` |
| Thanh toán (chỉ MoMo / VNPay sandbox) → ví thợ | `services/customer/interaction.service.js` (`createPayment`, `settlePayment`) → `services/worker/finance.service.js` (`recordPaidOrder`) | app khách `TrackScreen.tsx`; app thợ thông báo nổi + `screens/earnings/` |
| Rút tiền → admin duyệt | `services/worker/finance.service.js` (`createWithdrawal`, `processWithdrawal`), `routes/admin/dispatch.routes.js` | app thợ `WalletScreens.tsx`; web `components/finance/WithdrawalsPanel.tsx` |
| Đánh giá → điểm tin cậy | `interaction.service.js` (`createReview`) → `services/trust/trust.service.js` → `algorithms/trust.js` | app khách `ReviewScreen.tsx`; app thợ màn Hiệu suất |
| Khiếu nại, bảo hành, báo cáo sự cố của thợ | `interaction.service.js`; `services/worker/job.service.js` (`createReport`); `services/admin/complaint.service.js` | web `routes/_admin/complaints.tsx` |
| Bản đồ giám sát, tổng quan, thống kê | `services/admin/monitor.service.js`, `dashboard.service.js`, `report.service.js` | web `routes/_admin/monitor.tsx`, `index.tsx`, `reports.tsx` |

## 5. Sự kiện realtime (Socket.IO)

| Sự kiện | Phát ở | App nghe |
|---|---|---|
| `offer:new` / `offer:closed` | `services/matching/dispatch.service.js`, huỷ đơn (`customer/order.service.js`, `admin/order.service.js`) | app thợ (`realtime/useRealtime.ts` → `OfferCenter`) |
| `order:updated` | `shared/notify.service.js` → `emitOrderUpdated` (mọi chỗ đổi trạng thái đơn, báo giá, thanh toán) | cả 2 app |
| `worker:location` | `services/worker/profile.service.js` (thợ đang tới) | app khách (`TrackScreen`) |
| `message:new` | `services/customer/interaction.service.js` (chat dùng chung) | cả 2 app |
| `notification:new` | `shared/notify.service.js` → `notify()` | cả 2 app (app thợ hiện thông báo nổi khi khách trả tiền, khi lệnh rút được duyệt; tải lại hồ sơ khi có kết quả duyệt) |

## 6. Ba thuật toán chính (để vấn đáp)

1. **Ghép cặp** (`algorithms/scoring.js`, `greedy.js`, `hungarian.js`, `grouping.js`): mỗi cặp thợ – đơn có điểm S ∈ [0, 1] theo 5 tiêu chí có trọng số; đơn đứng riêng dùng Greedy (nhanh), nhóm đơn tranh cùng thợ dùng Hungarian (tối ưu tổng điểm). Chi tiết, độ phức tạp và kết quả thực nghiệm: `MATCHING.md`.
2. **Điểm tin cậy** (`algorithms/trust.js`): `0,5 · đánh giá làm mượt Bayes + 0,3 · giữ lời (hoàn thành / huỷ sau khi nhận) + 0,2 · khiếu nại đúng`; tính lại sau mỗi đánh giá, hoàn thành, huỷ, khiếu nại được xử lý; lưu `trust_score_history`. Là tiêu chí `s_trust` (trọng số 0,30) của ghép cặp.
3. **Tỷ lệ nhận đơn** (`services/matching/stats.js`): làm mượt Bayes với 3 lần nhận "ảo", chỉ tính lời mời thợ thật sự bỏ lỡ; là tiêu chí `s_acceptance`.

## 7. Kiểm thử (`npm test`)

| File | Phạm vi |
|---|---|
| `test/algorithms.test.js` | Hungarian so với vét cạn, Greedy, Union-Find, hàm điểm, hạng thợ, công thức điểm tin cậy (không cần CSDL) |
| `test/worker-flow.test.js` | app thợ: tài khoản, hồ sơ & duyệt, luồng đơn đầy đủ, thanh toán → ví, rút tiền, bộ điều phối các chế độ, điểm tin cậy, realtime |
| `test/customer-app.test.js` | app khách: tài khoản, đặt đơn khớp bộ điều phối và app thợ |
| `test/admin-dashboard.test.js` | web quản trị: duyệt từng giấy tờ, khiếu nại, bản đồ, thông báo, chi tiết đơn, tài chính |

Chạy 1 file: `node --test test/algorithms.test.js` (không cần CSDL).
