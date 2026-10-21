import * as monitorService from '../../services/monitor.service.js';
import { settings } from '../../config/worker.js';

export const map = async (req, res) => {
  res.json(await monitorService.getMapData({ locationMaxAgeMinutes: settings.locationMaxAgeMinutes }));
};
