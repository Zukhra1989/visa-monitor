const axios = require('axios');
const https = require('https');

const CONFIG = {
  email: process.env.VISA_EMAIL || 'jxusenov@list.ru',
  password: process.env.VISA_PASSWORD || '212Aziko@Zuxa1989@',
  scheduleIds: [], // оба ID (муж и жена)
  facilityId: 90,
  country: 'en-uz',
  telegramToken: process.env.TELEGRAM_TOKEN || '8763727275:AAH5oDZ_NxhJL7YgDxQwm0aCJUXp-E9sJpw',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '515561284',
  currentDate: '2026-08-26' // текущая запись — ищем любую дату раньше этой
};

const BASE_URL = 'https://ais.usvisa-info.com';
let cookies = '';
let csrfToken = '';
let foundDates = [];

const client = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL
  },
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      chat_id: CONFIG.telegramChatId,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.log('[TG] Error:', e.message);
  }
}

async function getCsrfToken() {
  try {
    const res = await client.get(`/${CONFIG.country}/niv/users/sign_in`);
    const match = res.data.match(/csrf-token"\s+content="([^"]+)"/);
    if (match) {
      csrfToken = match[1];
      const setCookie = res.headers['set-cookie'];
      if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');
      return true;
    }
  } catch (e) {}
  return false;
}

async function login() {
  try {
    const params = new URLSearchParams();
    params.append('user[email]', CONFIG.email);
    params.append('user[password]', CONFIG.password);
    params.append('policy_confirmed', '1');
    params.append('commit', 'Sign In');

    const res = await client.post(`/${CONFIG.country}/niv/users/sign_in`, params.toString(), {
      headers: {
        'X-CSRF-Token': csrfToken,
        'Cookie': cookies,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      },
      maxRedirects: 5
    });

    const setCookie = res.headers['set-cookie'];
    if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');
    return res.status === 200 || res.status === 302;
  } catch (e) {
    if (e.response && (e.response.status === 200 || e.response.status === 302)) {
      const setCookie = e.response.headers['set-cookie'];
      if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');
      return true;
    }
  }
  return false;
}

async function getScheduleIds() {
  const endpoints = [`/${CONFIG.country}/niv/account`, `/${CONFIG.country}/niv/dashboard`, `/${CONFIG.country}/niv`];
  for (const ep of endpoints) {
    try {
      const res = await client.get(ep, { headers: { 'Cookie': cookies } });
      const matches = [...res.data.matchAll(/\/schedule\/(\d+)\//g)];
      const ids = [...new Set(matches.map(m => m[1]))];
      if (ids.length > 0) {
        CONFIG.scheduleIds = ids;
        console.log('[OK] Schedule IDs найдены:', ids);
        return true;
      }
    } catch (e) {}
  }
  return false;
}

async function checkDates() {
  const scheduleId = CONFIG.scheduleIds[0];
  try {
    const res = await client.get(
      `/${CONFIG.country}/niv/schedule/${scheduleId}/appointment/days/${CONFIG.facilityId}.json?appointments[expedite]=false`,
      {
        headers: {
          'Cookie': cookies,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`
        }
      }
    );
    if (res.data && res.data.length > 0) return res.data;
    return [];
  } catch (e) {
    console.log('[ERR] Dates:', e.message);
    return null;
  }
}

async function getTimeSlots(date) {
  const scheduleId = CONFIG.scheduleIds[0];
  try {
    const res = await client.get(
      `/${CONFIG.country}/niv/schedule/${scheduleId}/appointment/times/${CONFIG.facilityId}.json?date=${date}&appointments[expedite]=false`,
      {
        headers: {
          'Cookie': cookies,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`
        }
      }
    );
    if (res.data && res.data.available_times && res.data.available_times.length > 0) {
      return res.data.available_times;
    }
    return [];
  } catch (e) {
    console.log('[ERR] Times:', e.message);
    return [];
  }
}

async function bookOneAppointment(scheduleId, date, time) {
  try {
    const pageRes = await client.get(
      `/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`,
      { headers: { 'Cookie': cookies } }
    );
    const csrfMatch = pageRes.data.match(/csrf-token"\s+content="([^"]+)"/);
    if (csrfMatch) csrfToken = csrfMatch[1];

    const params = new URLSearchParams();
    params.append('authenticity_token', csrfToken);
    params.append('confirmed_limit_message', '1');
    params.append('use_consulate_appointment_capacity', 'true');
    params.append('appointments[consulate_appointment][facility_id]', CONFIG.facilityId);
    params.append('appointments[consulate_appointment][date]', date);
    params.append('appointments[consulate_appointment][time]', time);

    const res = await client.post(
      `/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`,
      params.toString(),
      {
        headers: {
          'Cookie': cookies,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': csrfToken,
          'Referer': `${BASE_URL}/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`
        },
        maxRedirects: 5
      }
    );

    return res.status === 200 || res.status === 302;
  } catch (e) {
    console.log(`[ERR] Booking ${scheduleId}:`, e.message);
    return false;
  }
}

async function bookBothAppointments(date, time) {
  const results = [];
  for (const scheduleId of CONFIG.scheduleIds) {
    console.log(`[BOOKING] Бронирую для ID ${scheduleId}: ${date} ${time}`);
    const ok = await bookOneAppointment(scheduleId, date, time);
    results.push({ scheduleId, ok });
    await new Promise(r => setTimeout(r, 2000)); // пауза между запросами
  }
  return results;
}

async function getCurrentAppointment() {
  const scheduleId = CONFIG.scheduleIds[0];
  try {
    const res = await client.get(
      `/${CONFIG.country}/niv/schedule/${scheduleId}`,
      { headers: { 'Cookie': cookies } }
    );
    const html = res.data;

    // Формат на сайте: "26 August, 2026, 09:00 Tashkent local time"
    const m = html.match(/(\d{1,2}\s+\w+,\s+\d{4}),\s+(\d{2}:\d{2})/);
    if (m) {
      console.log('[OK] Appointment:', m[1], m[2]);
      return { date: m[1].trim(), time: m[2].trim() };
    }

    console.log('[INFO] Date not found on page');
    return null;
  } catch (e) {
    console.log('[ERR] getCurrentAppointment:', e.message);
    return null;
  }
}

async function checkTelegramCommands() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${CONFIG.telegramToken}/getUpdates?limit=10&timeout=1`
    );
    const updates = res.data.result || [];
    for (const update of updates) {
      const text = update.message?.text?.toUpperCase().trim();
      const chatId = update.message?.chat?.id?.toString();
      if (chatId !== CONFIG.telegramChatId) continue;
      if (text === 'BOOK' && foundDates.length > 0) return 'BOOK';
      if (text === 'STATUS') return 'STATUS';
      if (text === 'DATES') return 'DATES';
    }
  } catch (e) {}
  return null;
}

async function run() {
  console.log(`[${new Date().toISOString()}] Checking for dates earlier than ${CONFIG.currentDate}...`);

  await getCsrfToken();
  const loggedIn = await login();
  if (!loggedIn) { console.log('[ERR] Login failed'); return; }

  if (CONFIG.scheduleIds.length === 0) await getScheduleIds();
  if (CONFIG.scheduleIds.length === 0) { console.log('[ERR] No schedule IDs found'); return; }

  // Проверяем команды Telegram в первую очередь
  const command = await checkTelegramCommands();

  if (command === 'STATUS') {
    const appt = await getCurrentAppointment();
    await sendTelegram(
      `📋 <b>Текущая запись в посольство США</b>\n\n` +
      `📅 Дата: <b>${appt?.date || CONFIG.currentDate}</b>\n` +
      `🕐 Время: <b>${appt?.time || 'уточни на сайте'}</b>\n` +
      `👫 Заявители: муж и жена\n` +
      `🏢 Посольство: Ташкент\n\n` +
      `🔍 Бот ищет даты раньше ${CONFIG.currentDate}`
    );
    return;
  }

  if (command === 'DATES') {
    const dates = await checkDates();
    if (!dates || dates.length === 0) {
      await sendTelegram(`📅 <b>Доступные даты на сайте</b>\n\n❌ Сейчас нет свободных дат`);
    } else {
      const list = dates.slice(0, 20).map(d => {
        const isEarlier = d.date < CONFIG.currentDate;
        return `${isEarlier ? '✅' : '📌'} ${d.date}`;
      }).join('\n');
      const total = dates.length;
      await sendTelegram(
        `📅 <b>Все доступные даты на сайте (${total} шт.):</b>\n\n${list}` +
        (total > 20 ? `\n\n...и ещё ${total - 20} дат` : '') +
        `\n\n✅ — раньше твоей записи (${CONFIG.currentDate})\n📌 — позже твоей записи`
      );
    }
    return;
  }

  const dates = await checkDates();
  if (!dates) return;

  // Ищем любую дату раньше текущей записи
  const earlierDates = dates.filter(d => d.date && d.date < CONFIG.currentDate);

  if (earlierDates.length > 0) {
    foundDates = earlierDates.map(d => d.date);
    const list = foundDates.map(d => `• ${d}`).join('\n');

    const msg = `🗓 <b>Найдены более ранние даты!</b>\n\nДоступные даты:\n${list}\n\n` +
      `Твоя текущая дата: ${CONFIG.currentDate}\n\n` +
      `Чтобы <b>автоматически забронировать</b> первую доступную дату,\n` +
      `напиши боту: <b>BOOK</b>`;

    await sendTelegram(msg);
    console.log('[FOUND] Earlier dates:', foundDates);

    if (command === 'BOOK') {
      const targetDate = foundDates[0];
      console.log('[BOOKING] Бронирую:', targetDate);
      await sendTelegram(`⏳ Бронирую дату ${targetDate}...`);

      const times = await getTimeSlots(targetDate);
      if (times.length === 0) {
        await sendTelegram('❌ Нет доступного времени для этой даты. Попробую завтра.');
        return;
      }

      const selectedTime = times[0];
      const results = await bookBothAppointments(targetDate, selectedTime);

      const allOk = results.every(r => r.ok);
      const successCount = results.filter(r => r.ok).length;

      if (allOk) {
        await sendTelegram(
          `✅ <b>Запись успешно перенесена для обоих!</b>\n\n` +
          `📅 Новая дата: ${targetDate}\n` +
          `🕐 Время: ${selectedTime}\n` +
          `👫 Записаны: муж и жена\n\n` +
          `Проверь подтверждение на сайте:\nhttps://ais.usvisa-info.com/en-uz/niv`
        );
        console.log('[SUCCESS] Both booked:', targetDate, selectedTime);
      } else if (successCount > 0) {
        await sendTelegram(
          `⚠️ <b>Частичная запись!</b>\n\n` +
          `📅 Дата: ${targetDate} | 🕐 Время: ${selectedTime}\n` +
          `Записано ${successCount} из ${results.length}.\n\n` +
          `❗ Зайди на сайт и проверь вручную!`
        );
      } else {
        await sendTelegram('❌ Ошибка бронирования. Зайди на сайт вручную!');
      }
    }
  } else {
    console.log('[INFO] No earlier dates available. Current:', CONFIG.currentDate);
  }
}

run();
