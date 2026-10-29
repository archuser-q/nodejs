import * as monitorService from '../../services/admin/monitor.service.js';
import { settings } from '../../config/settings.js';

export const map = async (req, res) => {
  res.json(await monitorService.getMapData({ locationMaxAgeMinutes: settings.locationMaxAgeMinutes }));
};
