# dev-tools — chỉ để test App Khách hàng

Không thuộc phần app khách, không cần đẩy lên nhánh chung. Xoá cả thư mục thì server vẫn chạy
(app.js chỉ nạp `/api/dev` khi thư mục này tồn tại và `NODE_ENV` khác `production`).
Khi xoá, bỏ luôn 2 lệnh `seed:dev`, `simulate` trong `package.json`.

| File | Làm gì |
|---|---|
| `seed_dev.sql` + `seed-dev.js` | `npm run seed:dev` — danh mục, dịch vụ, cấu hình ghép cặp, 40 thợ online quanh Hà Nội, khách demo 0912345678 / 123456 |
| `worker-sim.service.js` | giả lập thao tác thợ: nhận đơn, đổi trạng thái, di chuyển, báo giá, nhắn tin, xác nhận tiền mặt |
| `dev.routes.js` | mở các thao tác trên ở `/api/dev/orders/:order/...` |
| `simulate-worker.js` | `npm run simulate -- <mã đơn> <lệnh>` gọi `/api/dev` |

```bash
npm run simulate -- TN261017000012 accept
npm run simulate -- TN261017000012 auto        # accept → on_the_way → move x3 → arrived → in_progress
npm run simulate -- TN261017000012 quote 50000 Thay van khoá
npm run simulate -- TN261017000012 completed
npm run simulate -- TN261017000012 confirm-cash
```
