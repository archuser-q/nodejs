import * as dashboardService from '../../services/dashboard.service.js';

export const overview = async (req, res) => {
  res.json(await dashboardService.getOverview());
};

export const pending = async (req, res) => {
  res.json(await dashboardService.getPending());
};
