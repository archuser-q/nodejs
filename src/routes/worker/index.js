import { Router } from 'express';
import * as account from '../../controllers/worker/account.controller.js';
import * as job from '../../controllers/worker/job.controller.js';
import * as finance from '../../controllers/worker/finance.controller.js';
import { requireWorker } from '../../middlewares/requireWorker.js';

/**
 * API App Thợ — /api/worker/...  [Thành viên B]
 * Đăng nhập trả về token, các API còn lại gửi header "Authorization: Bearer <token>" (role = worker).
 * Quy ước giống app khách: trả JSON trực tiếp, lỗi { message }, danh sách { items, total, page, pageSize }.
 */
const router = Router();

// ── Không cần đăng nhập ─────────────────────────────────────────────────────
router.post('/auth/register', account.register);
router.post('/auth/login', account.login);
router.get('/auth/providers', account.providers);
router.post('/auth/google', account.google);
router.post('/auth/facebook', account.facebook);
router.post('/auth/forgot-password', account.forgotPassword);
router.post('/auth/reset-password', account.resetPassword);
router.get('/catalog/categories', account.categories);
router.get('/catalog/services', account.services);

router.use(requireWorker);

router.get('/auth/me', account.authMe);
router.post('/auth/change-password', account.changePassword);

// ── Hồ sơ & xác minh ────────────────────────────────────────────────────────
router.get('/me', account.me);
router.patch('/profile', account.updateProfile);
router.put('/skills', account.setSkills);
router.get('/documents', account.listDocuments);
router.post('/documents', account.addDocument);
router.delete('/documents/:id', account.deleteDocument);
router.post('/verification/submit', account.submitVerification);
router.get('/bank-account', account.getBankAccount);
router.put('/bank-account', account.setBankAccount);

// ── Nhận đơn & vị trí ───────────────────────────────────────────────────────
router.get('/home', account.home);
router.patch('/availability', account.setAvailability);
router.patch('/location', account.updateLocation);
router.get('/offers/current', job.currentOffer);
router.post('/offers/:offerId/accept', job.acceptOffer);
router.post('/offers/:offerId/reject', job.rejectOffer);

// ── Đơn của tôi ─────────────────────────────────────────────────────────────
router.get('/orders', job.list);
router.get('/orders/:id', job.detail);
router.post('/orders/:id/status', job.advance);
router.post('/orders/:id/cancel', job.cancel);
router.post('/orders/:id/photos', job.addPhotos);
router.delete('/orders/:id/photos/:photoId', job.deletePhoto);
router.post('/orders/:id/extra-quotes', job.createQuote);
router.post('/orders/:id/extra-quotes/:quoteId/cancel', job.cancelQuote);
router.post('/orders/:id/confirm-cash', job.confirmCash);
router.post('/orders/:id/report', job.report);
router.get('/orders/:id/messages', job.listMessages);
router.post('/orders/:id/messages', job.sendMessage);
router.post('/orders/:id/messages/read', job.markMessagesRead);
router.get('/reports', job.reports);

// ── Thu nhập & ví ───────────────────────────────────────────────────────────
router.get('/earnings/summary', finance.earningsSummary);
router.get('/earnings', finance.earnings);
router.get('/wallet', finance.wallet);
router.get('/wallet/transactions', finance.transactions);
router.post('/wallet/withdrawals', finance.withdraw);
router.get('/wallet/withdrawals', finance.withdrawals);
router.post('/wallet/topup', finance.topup);

// ── Đánh giá & hiệu suất ────────────────────────────────────────────────────
router.get('/reviews', finance.reviews);
router.get('/performance', finance.performance);

// ── Thông báo ───────────────────────────────────────────────────────────────
router.get('/notifications', account.listNotifications);
router.get('/notifications/unread-count', account.unreadCount);
router.patch('/notifications/read-all', account.markAllNotificationsRead);
router.patch('/notifications/:id/read', account.markNotificationRead);
router.post('/device-tokens', account.registerDevice);
router.delete('/device-tokens/:token', account.removeDevice);

export default router;
