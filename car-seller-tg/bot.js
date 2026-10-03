import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as DB from './db.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===================== ВАЛИДАЦИЯ initData =====================
function validateInitData(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calc !== hash) return null;
    const user = JSON.parse(params.get('user') || '{}');
    return user.id ? user : null;
  } catch { return null; }
}

function auth(req, res, next) {
  const user = validateInitData(req.body?.initData || req.query?.initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.tgUser = user;
  next();
}

// ===================== ДОНАТ-ТОВАРЫ =====================
const DONATE_ITEMS = {
  premium:      { title: '👑 Premium 24ч',     description: '+50% дохода и авто-продажа на 24 часа',    stars: 250, duration: 24*60*60*1000 },
  multiplier2x: { title: '✖️ Множитель x2',     description: 'Удваивает доход на 1 час',                 stars: 100, duration: 60*60*1000 },
  startPack:    { title: '🎁 Стартовый набор',  description: 'Мгновенно +$100,000',                      stars: 50,  bonusMoney: 100000 },
  megaPack:     { title: '💎 Мега-набор',       description: 'Premium 24ч + x2 1ч + $500,000',           stars: 400, bonusMoney: 500000, premium: true, multiplier: true }
};

// ===================== /start с реф-кодом =====================
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const refCode = match[1]?.trim() || null;

  const player = DB.getOrCreatePlayer(userId, msg.from.username, msg.from.first_name, refCode);

  if (refCode && player.referrer_id) {
    bot.sendMessage(chatId, '🎁 Ты пришёл по реферальной ссылке! Бонус +$5,000 уже начислен.');
    // Уведомляем реферера
    bot.sendMessage(player.referrer_id,
      `🎉 По твоей ссылке пришёл новый игрок!\nБонус: +$50,000 будет начислен после его первой покупки.`
    ).catch(() => {});
  }

  bot.sendMessage(chatId,
    `🚗 Привет, ${msg.from.first_name || 'игрок'}!\n\n` +
    `Строй автомобильную империю. Приглашай друзей и получай бонусы!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 Играть', web_app: { url: process.env.WEBAPP_URL } }],
          [{ text: '💎 Донат-магазин', callback_data: 'shop' }],
          [{ text: '👥 Пригласить друга', callback_data: 'ref' }],
          [{ text: '🏆 Лидерборд', callback_data: 'top' }]
        ]
      }
    }
  );
});

// ===================== КОМАНДЫ =====================
bot.onText(/\/shop/, (msg) => sendShop(msg.chat.id));

function sendShop(chatId) {
  const keyboard = Object.entries(DONATE_ITEMS).map(([key, item]) => ([{
    text: `${item.title} — ${item.stars} ⭐`,
    callback_data: `buy:${key}`
  }]));
  bot.sendMessage(chatId, '💎 *Донат-магазин:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.onText(/\/ref/, (msg) => sendRef(msg));

function sendRef(msg) {
  const player = DB.getOrCreatePlayer(msg.from.id, msg.from.username, msg.from.first_name);
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=${player.ref_code}`;
  const ref = DB.getReferrals(msg.from.id);

  bot.sendMessage(msg.chat.id,
    `👥 *Приглашай друзей!*\n\n` +
    `За каждого друга ты получаешь:\n` +
    `• +$50,000 (после его первой покупки)\n` +
    `• 10% от его донатов в Stars\n\n` +
    `Твоя ссылка:\n\`${link}\`\n\n` +
    `👤 Приглашено: *${ref.count}*`,
    { parse_mode: 'Markdown' }
  );
}

bot.onText(/\/top/, (msg) => sendTop(msg.chat.id, msg.from.id));

function sendTop(chatId, myId = null) {
  const top = DB.getLeaderboard(10);
  const medals = ['🥇', '🥈', '🥉'];
  let text = '🏆 *Топ-10 игроков:*\n\n';
  top.forEach((p, i) => {
    const mark = medals[i] || `${i + 1}.`;
    const name = p.first_name || p.username || `Игрок${p.user_id}`;
    const highlight = p.user_id === myId ? ' ⬅️' : '';
    text += `${mark} ${name} — $${Math.floor(p.total_earned).toLocaleString()}${highlight}\n`;
  });

  if (myId) {
    const rank = DB.getPlayerRank(myId);
    if (rank > 10) text += `\n📍 Твоё место: #${rank}`;
  }

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// ===================== CALLBACK =====================
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (data === 'shop') return sendShop(chatId);
  if (data === 'ref')  return sendRef({ chat: { id: chatId }, from: query.from });
  if (data === 'top')  return sendTop(chatId, userId);

  if (data.startsWith('buy:')) {
    const key = data.split(':')[1];
    const item = DONATE_ITEMS[key];
    if (!item) return bot.answerCallbackQuery(query.id, { text: 'Товар не найден' });

    try {
      await bot.sendInvoice(chatId, {
        title: item.title,
        description: item.description,
        payload: JSON.stringify({ userId, itemKey: key }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: item.title, amount: item.stars }]
      });
      bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error('sendInvoice error:', err);
      bot.answerCallbackQuery(query.id, { text: 'Ошибка создания счёта' });
    }
  }
});

// ===================== ПЛАТЕЖИ =====================
bot.on('pre_checkout_query', (q) => {
  bot.answerPreCheckoutQuery(q.id, true).catch(console.error);
});

bot.on('successful_payment', async (msg) => {
  const payment = msg.successful_payment;
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  let payload;
  try { payload = JSON.parse(payment.invoice_payload); } catch { return; }

  const item = DONATE_ITEMS[payload.itemKey];
  if (!item) return;

  DB.savePurchase(payment.telegram_payment_charge_id, userId, payload.itemKey, payment.total_amount);

  // Реферальный бонус рефереру (+$50,000 за первую покупку)
  const referrerId = DB.rewardReferrer(userId, 50000);
  if (referrerId) {
    bot.sendMessage(referrerId,
      `💰 Твой реферал совершил первую покупку!\n+$50,000 начислено.`
    ).catch(() => {});
  }

  bot.sendMessage(chatId,
    `✅ *Оплата получена!*\n\n` +
    `${item.title} активирован.\n` +
    `⭐ Потрачено: ${payment.total_amount} Stars`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 Открыть игру', web_app: { url: process.env.WEBAPP_URL } }]]
      }
    }
  );
});

// ===================== API MINI APP =====================
app.post('/api/state', auth, (req, res) => {
  const userId = req.tgUser.id;
  const player = DB.getOrCreatePlayer(userId, req.tgUser.username, req.tgUser.first_name);
  const now = Date.now();

  res.json({
    money: player.money,
    totalEarned: player.total_earned,
    cars: DB.getCars(userId),
    upgrades: DB.getUpgrades(userId),
    premium: {
      active: player.premium_until > now,
      expires: player.premium_until
    },
    multiplier: {
      active: player.multiplier_until > now,
      expires: player.multiplier_until
    },
    refCode: player.ref_code,
    refCount: player.ref_count
  });
});

app.post('/api/buy-car', auth, (req, res) => {
  const { carId, carPrice } = req.body;
  const userId = req.tgUser.id;
  const player = DB.getPlayer(userId);
  if (!player || player.money < carPrice) return res.status(400).json({ error: 'no money' });
  DB.updateMoney(userId, -carPrice);
  DB.addCar(userId, carId, 1);
  res.json({ ok: true, money: DB.getPlayer(userId).money });
});

app.post('/api/sell-car', auth, (req, res) => {
  const { carId, sellPrice } = req.body;
  const userId = req.tgUser.id;
  DB.addCar(userId, carId, -1);
  DB.updateMoney(userId, sellPrice);
  res.json({ ok: true, money: DB.getPlayer(userId).money });
});

app.post('/api/buy-upgrade', auth, (req, res) => {
  const { upId, price, newLevel } = req.body;
  const userId = req.tgUser.id;
  const player = DB.getPlayer(userId);
  if (!player || player.money < price) return res.status(400).json({ error: 'no money' });
  DB.updateMoney(userId, -price);
  DB.setUpgrade(userId, upId, newLevel);
  res.json({ ok: true, money: DB.getPlayer(userId).money });
});

app.post('/api/sync-earnings', auth, (req, res) => {
  const { amount } = req.body;
  const userId = req.tgUser.id;
  const safe = Math.min(Math.max(0, amount || 0), 1e12);
  DB.updateMoney(userId, safe);
  res.json({ ok: true });
});

// ===== ЕЖЕДНЕВНЫЙ БОНУС =====
app.post('/api/daily', auth, (req, res) => {
  const result = DB.claimDaily(req.tgUser.id);
  res.json(result);
});

app.get('/api/daily-status', auth, (req, res) => {
  const row = DB.prepare?.('SELECT * FROM daily WHERE user_id = ?').get?.(req.tgUser.id);
  // Упрощённо: пробуем через claimDaily "на сухую"
  const now = Date.now();
  const db = require('./db.js');
  const r = db.default.prepare('SELECT * FROM daily WHERE user_id = ?').get(req.tgUser.id);
  if (!r) return res.json({ canClaim: true, streak: 0 });
  const waitMs = 24 * 60 * 60 * 1000 - (now - r.last_claim);
  res.json({ canClaim: waitMs <= 0, streak: r.streak, waitSec: Math.max(0, Math.ceil(waitMs / 1000)) });
});

// ===== РЕФЕРАЛЫ =====
app.post('/api/referrals', auth, (req, res) => {
  const userId = req.tgUser.id;
  const player = DB.getPlayer(userId);
  const ref = DB.getReferrals(userId);
  res.json({
    code: player.ref_code,
    count: ref.count,
    link: `https://t.me/${process.env.BOT_USERNAME}?start=${player.ref_code}`,
    bonusPerRef: 50000
  });
});

// ===== ЛИДЕРБОРД =====
app.post('/api/leaderboard', auth, (req, res) => {
  const top = DB.getLeaderboard(20);
  const myRank = DB.getPlayerRank(req.tgUser.id);
  res.json({ top, myRank });
});

// ===== ДОНАТ =====
app.post('/api/create-invoice', auth, async (req, res) => {
  const { itemKey } = req.body;
  const item = DONATE_ITEMS[itemKey];
  if (!item) return res.status(400).json({ error: 'unknown item' });
  try {
    const link = await bot.createInvoiceLink({
      title: item.title,
      description: item.description,
      payload: JSON.stringify({ userId: req.tgUser.id, itemKey }),
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: item.title, amount: item.stars }]
    });
    res.json({ link });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'invoice failed' });
  }
});

app.post('/api/claim', auth, (req, res) => {
  const items = DB.claimPurchases(req.tgUser.id);
  res.json({ items: items.map(itemKey => ({ itemKey })) });
});

// ===================== ЗАПУСК =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));