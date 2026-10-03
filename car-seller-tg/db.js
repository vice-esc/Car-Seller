import Database from 'better-sqlite3';

const db = new Database('game.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    user_id       INTEGER PRIMARY KEY,
    username      TEXT,
    first_name    TEXT,
    money         REAL DEFAULT 500,
    total_earned  REAL DEFAULT 0,
    premium_until INTEGER DEFAULT 0,
    multiplier_until INTEGER DEFAULT 0,
    referrer_id   INTEGER,
    ref_code      TEXT UNIQUE,
    ref_count     INTEGER DEFAULT 0,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS cars (
    user_id  INTEGER,
    car_id   TEXT,
    count    INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, car_id)
  );

  CREATE TABLE IF NOT EXISTS upgrades (
    user_id  INTEGER,
    up_id    TEXT,
    level    INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, up_id)
  );

  CREATE TABLE IF NOT EXISTS purchases (
    charge_id  TEXT PRIMARY KEY,
    user_id    INTEGER,
    item_key   TEXT,
    stars      INTEGER,
    claimed    INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS daily (
    user_id    INTEGER PRIMARY KEY,
    last_claim INTEGER DEFAULT 0,
    streak     INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS referrals (
    referrer_id INTEGER,
    invited_id  INTEGER UNIQUE,
    rewarded    INTEGER DEFAULT 0,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ===================== ИГРОКИ =====================
export function getOrCreatePlayer(userId, username = null, firstName = null, refCode = null) {
  let p = db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
  if (p) {
    if (username !== null || firstName !== null) {
      db.prepare('UPDATE players SET username = COALESCE(?, username), first_name = COALESCE(?, first_name) WHERE user_id = ?')
        .run(username, firstName, userId);
    }
    return p;
  }

  // Генерируем уникальный реф-код
  let myRefCode;
  do {
    myRefCode = 'u' + userId.toString(36) + Math.random().toString(36).slice(2, 6);
  } while (db.prepare('SELECT 1 FROM players WHERE ref_code = ?').get(myRefCode));

  // Находим реферера
  let referrerId = null;
  if (refCode) {
    const ref = db.prepare('SELECT user_id FROM players WHERE ref_code = ?').get(refCode);
    if (ref && ref.user_id !== userId) referrerId = ref.user_id;
  }

  db.prepare('INSERT INTO players (user_id, username, first_name, referrer_id, ref_code) VALUES (?, ?, ?, ?, ?)')
    .run(userId, username, firstName, referrerId, myRefCode);

  // Регистрируем реферал и даём бонусы
  if (referrerId) {
    db.prepare('INSERT OR IGNORE INTO referrals (referrer_id, invited_id) VALUES (?, ?)').run(referrerId, userId);
    db.prepare('UPDATE players SET ref_count = ref_count + 1 WHERE user_id = ?').run(referrerId);
    // Бонус приглашённому: $5,000
    db.prepare('UPDATE players SET money = money + 5000 WHERE user_id = ?').run(userId);
  }

  return db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
}

export function getPlayer(userId) {
  return db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
}

export function updateMoney(userId, amount) {
  db.prepare('UPDATE players SET money = money + ?, total_earned = total_earned + ? WHERE user_id = ?')
    .run(amount, Math.max(0, amount), userId);
}

export function setPremium(userId, until) {
  db.prepare('UPDATE players SET premium_until = ? WHERE user_id = ?').run(until, userId);
}

export function setMultiplier(userId, until) {
  db.prepare('UPDATE players SET multiplier_until = ? WHERE user_id = ?').run(until, userId);
}

// ===================== МАШИНЫ =====================
export function getCars(userId) {
  const rows = db.prepare('SELECT car_id, count FROM cars WHERE user_id = ?').all(userId);
  const obj = {};
  rows.forEach(r => obj[r.car_id] = r.count);
  return obj;
}

export function addCar(userId, carId, delta) {
  db.prepare(`
    INSERT INTO cars (user_id, car_id, count) VALUES (?, ?, ?)
    ON CONFLICT(user_id, car_id) DO UPDATE SET count = count + ?
  `).run(userId, carId, delta, delta);
  db.prepare('DELETE FROM cars WHERE user_id = ? AND car_id = ? AND count <= 0').run(userId, carId);
}

// ===================== УЛУЧШЕНИЯ =====================
export function getUpgrades(userId) {
  const rows = db.prepare('SELECT up_id, level FROM upgrades WHERE user_id = ?').all(userId);
  const obj = { incomeBoost: 0, autoSeller: 0, marketing: 0 };
  rows.forEach(r => obj[r.up_id] = r.level);
  return obj;
}

export function setUpgrade(userId, upId, level) {
  db.prepare(`
    INSERT INTO upgrades (user_id, up_id, level) VALUES (?, ?, ?)
    ON CONFLICT(user_id, up_id) DO UPDATE SET level = ?
  `).run(userId, upId, level, level);
}

// ===================== ПОКУПКИ =====================
export function savePurchase(chargeId, userId, itemKey, stars) {
  db.prepare('INSERT OR IGNORE INTO purchases (charge_id, user_id, item_key, stars) VALUES (?, ?, ?, ?)')
    .run(chargeId, userId, itemKey, stars);
}

export function claimPurchases(userId) {
  const rows = db.prepare('SELECT charge_id, item_key FROM purchases WHERE user_id = ? AND claimed = 0').all(userId);
  if (rows.length) {
    const ids = rows.map(r => r.charge_id);
    db.prepare(`UPDATE purchases SET claimed = 1 WHERE charge_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  return rows.map(r => r.item_key);
}

// ===================== ЕЖЕДНЕВНЫЙ БОНУС =====================
export function claimDaily(userId) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let row = db.prepare('SELECT * FROM daily WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO daily (user_id, last_claim, streak) VALUES (?, ?, 1)').run(userId, now);
    return { ok: true, streak: 1, reward: 1000 };
  }
  const elapsed = now - row.last_claim;
  if (elapsed < dayMs) {
    return { ok: false, waitSec: Math.ceil((dayMs - elapsed) / 1000), streak: row.streak };
  }
  // Сброс стрика если пропустил больше 2 дней
  const newStreak = elapsed > dayMs * 2 ? 1 : row.streak + 1;
  const reward = 1000 * newStreak;
  db.prepare('UPDATE daily SET last_claim = ?, streak = ? WHERE user_id = ?').run(now, newStreak, userId);
  updateMoney(userId, reward);
  return { ok: true, streak: newStreak, reward };
}

// ===================== РЕФЕРАЛЫ =====================
export function getReferrals(userId) {
  const invited = db.prepare('SELECT COUNT(*) c FROM referrals WHERE referrer_id = ?').get(userId).c;
  const player = getPlayer(userId);
  return {
    count: invited,
    code: player?.ref_code,
    // Бонус: 10% от доната каждого реферала идёт рефереру в Stars (оффлайн, вручную)
    bonus: invited * 50000 // $50k за каждого
  };
}

export function rewardReferrer(invitedId, amount) {
  const ref = db.prepare('SELECT referrer_id FROM referrals WHERE invited_id = ? AND rewarded = 0').get(invitedId);
  if (!ref) return null;
  db.prepare('UPDATE referrals SET rewarded = 1 WHERE invited_id = ?').run(invitedId);
  updateMoney(ref.referrer_id, amount);
  return ref.referrer_id;
}

// ===================== ЛИДЕРБОРД =====================
export function getLeaderboard(limit = 20) {
  return db.prepare(`
    SELECT user_id, first_name, username, total_earned, ref_count
    FROM players
    ORDER BY total_earned DESC
    LIMIT ?
  `).all(limit);
}

export function getPlayerRank(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM players WHERE total_earned > (
      SELECT total_earned FROM players WHERE user_id = ?
    )
  `).get(userId);
  return row?.rank || 0;
}

export default db;