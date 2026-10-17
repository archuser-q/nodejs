import { Router } from 'express';
import * as account from '../../controllers/customer/account.controller.js';
import * as order from '../../controllers/customer/order.controller.js';
import { requireCustomer } from '../../middlewares/requireCustomer.js';

// Tất cả API app khách nằm dưới /api/customer. Đăng nhập trả về token, các API còn lại gửi
// header "Authorization: Bearer <token>".
const router = Router();

// Không cần đăng nhập
router.post('/auth/register', account.register);
router.post('/auth/login', account.login);
router.get('/catalog/categories', account.listCategories);
router.get('/catalog/services', account.listServices);

router.use(requireCustomer);

router.get('/auth/me', account.me);
router.patch('/profile', account.updateProfile);

router.get('/addresses', account.listAddresses);
router.post('/addresses', account.createAddress);
router.patch('/addresses/:id', account.updateAddress);
router.delete('/addresses/:id', account.deleteAddress);

router.post('/orders', order.create);
router.get('/orders', order.list);
router.get('/orders/:id', order.detail);
router.post('/orders/:id/cancel', order.cancel);
router.get('/orders/:id/tracking', order.tracking);
router.post('/orders/:id/quotes/:quoteId/approve', order.respondQuote(true));
router.post('/orders/:id/quotes/:quoteId/reject', order.respondQuote(false));
router.get('/orders/:id/messages', order.listMessages);
router.post('/orders/:id/messages', order.sendMessage);
router.post('/orders/:id/messages/read', order.markMessagesRead);
router.post('/orders/:id/payments', order.createPayment);
router.post('/orders/:id/review', order.createReview);
router.post('/orders/:id/complaints', order.createComplaint);
router.post('/orders/:id/warranty-claim', order.claimWarranty);

router.get('/payments', order.listPayments);
router.post('/payments/:id/sandbox-confirm', order.sandboxConfirm);
router.get('/reviews', order.listReviews);
router.get('/complaints', order.listComplaints);
router.get('/workers/:id', order.workerProfile);

router.get('/notifications', order.listNotifications);
router.get('/notifications/unread-count', order.unreadCount);
router.patch('/notifications/read-all', order.markAllNotificationsRead);
router.patch('/notifications/:id/read', order.markNotificationRead);

export default router;
