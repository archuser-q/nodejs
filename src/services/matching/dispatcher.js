/**
 * Vòng điều phối chạy nền theo nhịp (tick) vài giây một lần.  [Thành viên B]
 *
 * Mỗi tick:
 *   1. Offer quá hạn trả lời -> expired; offer của đơn đã đóng -> đóng; nhận các đơn chưa vào hàng đợi
 *   2. instant: gửi đợt offer tiếp theo cho các đơn tới lượt
 *   3. auto:    chia đơn đang chờ theo nhóm tranh chấp thợ -> Greedy top-k hoặc Hungarian
 *      batch:   đủ batch_window_seconds thì chạy 1 lượt Hungarian
 *   4. Huỷ đơn quá hạn chờ; định kỳ: đồng bộ cờ bận, nhắc thợ trước giờ hẹn
 *
 * Chỉ 1 tiến trình làm "leader" (giữ khoá advisory phiên của PostgreSQL trên 1 kết nối riêng),
 * nên chạy nhiều instance API cũng không gửi offer trùng.
 */
import pg from 'pg';
import { env } from '../../config/env.js';
import { pool } from '../../config/db.js';
import { settings } from '../../config/settings.js';
import { getConfig } from './config.js';
import * as d from './dispatch.service.js';
import { syncBusyFlags } from '../worker/state.js';

const LEADER_KEY = 815000;
const SYNC_EVERY_MS = 10_000;
const REMINDER_EVERY_MS = 30_000;

class Dispatcher {
  leader = null; // kết nối giữ khoá leader
  timer = null;
  running = false;
  stopped = true;
  lastBatchAt = 0;
  lastSyncAt = 0;
  lastReminderAt = 0;
  stats = { ticks: 0, last_tick_at: null, last_error: null, last_auto: null, last_batch: null, offers_sent: 0 };

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(500);
    console.log(`[dispatcher] bật, nhịp ${settings.dispatcherTickSeconds}s`);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.release();
  }

  schedule(ms) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loop(), ms);
    this.timer.unref?.();
  }

  async release() {
    if (!this.leader) return;
    const c = this.leader;
    this.leader = null;
    await c.end().catch(() => {});
  }

  async isLeader() {
    if (this.leader) return true;
    const client = new pg.Client({ connectionString: env.databaseUrl });
    client.on('error', () => this.release());
    await client.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_KEY]);
    if (rows[0].ok) {
      this.leader = client;
      console.log('[dispatcher] tiến trình này là leader');
      return true;
    }
    await client.end();
    return false;
  }

  async loop() {
    if (this.running) return;
    this.running = true;
    let wait = settings.dispatcherTickSeconds * 1000;
    try {
      if (await this.isLeader()) await this.tick();
      else wait = 5000;
    } catch (err) {
      this.stats.last_error = { at: new Date(), message: err.message };
      console.error('[dispatcher] lỗi trong tick', err);
      await this.release();
    } finally {
      this.running = false;
      this.schedule(wait);
    }
  }

  async tick() {
    const cfg = await getConfig(pool);
    await d.expireOffers();
    await d.closeStaleOffers();
    await d.adoptOrphans(cfg);
    this.stats.offers_sent += await d.runDueInstant(cfg);

    const auto = await d.runAutoRound(cfg);
    if (auto.orders) this.stats.last_auto = { at: new Date(), ...auto, batch: { ...auto.batch, pairs: undefined } };
    this.stats.offers_sent += auto.instant_offers + auto.batch.assigned;

    const now = Date.now();
    if (now - this.lastBatchAt >= (cfg.batch_window_seconds || 10) * 1000) {
      this.lastBatchAt = now;
      const batch = await d.runBatchRound(cfg);
      if (batch.orders) this.stats.last_batch = { at: new Date(), ...batch, pairs: undefined };
      this.stats.offers_sent += batch.assigned;
    }

    await d.cancelOverdue();
    if (now - this.lastSyncAt >= SYNC_EVERY_MS) {
      this.lastSyncAt = now;
      await syncBusyFlags(pool);
    }
    if (now - this.lastReminderAt >= REMINDER_EVERY_MS) {
      this.lastReminderAt = now;
      await d.sendScheduleReminders();
    }
    this.stats.ticks += 1;
    this.stats.last_tick_at = new Date();
  }

  status() {
    return { enabled: !this.stopped, leader: !!this.leader, tick_seconds: settings.dispatcherTickSeconds, ...this.stats };
  }
}

export const dispatcher = new Dispatcher();
