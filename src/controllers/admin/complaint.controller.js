import * as complaintService from '../../services/complaint.service.js';
import { AppError } from '../../utils/AppError.js';

const STATUSES = ['open', 'processing', 'resolved', 'rejected'];
const TYPES = ['complaint', 'warranty'];
const isId = (v) => /^\d+$/.test(v);

export const list = async (req, res) => {
  const { search, status, type } = req.query;
  if (status && !STATUSES.includes(status)) throw new AppError(400, 'Invalid status');
  if (type && !TYPES.includes(type)) throw new AppError(400, 'Invalid type');

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const result = await complaintService.listComplaints({ search: search?.trim(), status, type, page, pageSize });
  res.json({ ...result, page, pageSize });
};

export const detail = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Invalid id');
  res.json(await complaintService.getComplaintDetail(req.params.id));
};

export const handle = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Invalid id');

  const { status } = req.body ?? {};
  const resolution = req.body?.resolution?.trim() || null;
  if (!['processing', 'resolved', 'rejected'].includes(status)) throw new AppError(400, 'Invalid status');
  if (status !== 'processing' && !resolution) throw new AppError(400, 'Resolution is required');

  const complaint = await complaintService.handleComplaint(req.params.id, req.user.id, status, resolution);
  res.json({ message: 'Complaint updated', complaint });
};