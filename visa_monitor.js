const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  email: process.env.VISA_EMAIL,
  password: process.env.VISA_PASSWORD,
  facilityId: 90,
  country: 'en-uz',
  telegramToken: process.env.TELEGRAM_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  githubToken: process.env.GITHUB_TOKEN,
  githubRepo: process.env.GITHUB_REPOSITORY,
};

// Проверка обязательных переменных
const missing = ['email', 'password', 'telegramToken', 'telegramChatId']
  .filter(k => !CONFIG[k]);
if (missing.length) {
  console.error('[FATAL] Не заданы переменные окружения:', missing.map(k => k.toUpperCase()).join(', '));
  process.exit(1);
}

const BASE_URL = 'https://ais.usvisa-info.com';
let cookies = '';
let csrfToken = '';

const client = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
  },
});

// ── Состояние (хранится в state.json в репозитории) ───────────────────────────
const STATE_FILE = 'state.json';
let state = {
  currentDate: '2026-08-26',   // обновляется автоматически при каждом запуске
  scheduleIds: [],
  lastUpdateId: 0,
  lastNotifiedDates: [],
  pendingBook: false,
  cookies: '',                  // сохранённая сессия — не входим каждый раз
};

async function loadState() {
  if (!CONFIG.githubToken || !CONFIG.githubRepo) {
    console.log('[STATE] Нет GITHUB_TOKEN — работаю без сохранения состояния');
    return;
  }
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${CONFIG.githubRepo}/contents/${STATE_FILE}`,
      { headers: { Authorization: `token ${CONFIG.githubToken}`, 'User-Agent': 'visa-bot' } }
    );
    const raw = Buffer.from(res.data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
    state = { ...state, ...JSON.parse(raw) };
    state._sha = res.data.sha;
    console.log('[STATE] Загружено:', {
      currentDate: state.currentDate,
      scheduleIds: state.scheduleIds,
      lastUpdateId: state.lastUpdateId,
      pendingBook: state.pendingBook,
    });
  } catch (e) {
    if (e.response?.status === 404) {
      console.log('[STATE] Файл состояния не найден, используется начальное состояние');
    } else {
      console.log('[STATE] Ошибка загрузки:', e.message);
    }
  }
}

async function saveState() {
  if (!CONFIG.githubToken || !CONFIG.githubRepo) return;
  try {
    const { _sha, ...toSave } = state;
    const content = Buffer.from(JSON.stringify(toSave, null, 2)).toString('base64');
    const body = { message: 'chore: update bot state', content };
    if (_sha) body.sha = _sha;
    const res = await axios.put(
      `https://api.github.com/repos/${CONFIG.githubRepo}/contents/${STATE_FILE}`,
      body,
      { headers: { Authorization: `token ${CONFIG.githubToken}`, 'User-Agent': 'visa-bot' } }
    );
    state._sha = res.data.content.sha;
    console.log('[STATE] Сохранено');
  } catch (e) {
    console.log('[STATE] Ошибка сохранения:', e.message);
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      chat_id: CONFIG.telegramChatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.log('[TG] Ошибка отправки:', e.message);
  }
}

// Читает новые команды с учётом offset — не повторяет уже обработанные сообщения
async function checkTelegramCommands() {
  try {
    const offset = state.lastUpdateId > 0 ? `&offset=${state.lastUpdateId + 1}` : '';
    const res = await axios.get(
      `https://api.telegram.org/bot${CONFIG.telegramToken}/getUpdates?limit=20&timeout=1${offset}`
    );
    const updates = res.data.result || [];
    if (updates.length === 0) return null;

    // Сохраняем последний update_id чтобы не читать эти сообщения снова
    state.lastUpdateId = Math.max(...updates.map(u => u.update_id));

    // Берём все новые сообщения (offset защищает от повторов), сначала новые
    const recent = updates
      .filter(u => u.message)
      .reverse();

    for (const upd of recent) {
      const text = upd.message?.text?.toUpperCase().trim();
      const chatId = upd.message?.chat?.id?.toString();
      if (chatId !== CONFIG.telegramChatId) continue;

      if (text === '/START' || text === 'START' || text === '/HELP' || text === 'HELP') return 'HELP';
      if (text === 'STATUS')   return 'STATUS';
      if (text === 'DATES')    return 'DATES';
      if (text === 'BOOK')     return 'BOOK';
      if (text === 'BOOK_YES') return 'BOOK_YES';
      if (text === 'CANCEL')   return 'CANCEL';
    }
  } catch (e) {
    console.log('[TG] Ошибка getUpdates:', e.message);
  }
  return null;
}

// ── Авторизация ───────────────────────────────────────────────────────────────

// Проверяет живы ли сохранённые cookies — без нового входа
async function isSessionValid() {
  if (!cookies) return false;
  try {
    const res = await client.get(`/${CONFIG.country}/niv`, {
      headers: { Cookie: cookies },
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    // Если залогинены — на странице есть ссылка "sign_out"
    const loggedIn = res.data && res.data.includes('sign_out');
    console.log(`[AUTH] Проверка сессии: ${loggedIn ? 'активна' : 'истекла'}`);
    return loggedIn;
  } catch (e) {
    console.log('[AUTH] Ошибка проверки сессии:', e.message);
    return false;
  }
}

async function getCsrfAndCookies() {
  try {
    const res = await client.get(`/${CONFIG.country}/niv/users/sign_in`);
    const match = res.data.match(/csrf-token"\s+content="([^"]+)"/);
    if (match) {
      csrfToken = match[1];
      const setCookie = res.headers['set-cookie'];
      if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');
      return true;
    }
  } catch (e) {
    console.log('[ERR] getCsrf:', e.message);
  }
  return false;
}

async function login() {
  const ok = await getCsrfAndCookies();
  if (!ok) return false;
  try {
    const params = new URLSearchParams({
      'user[email]': CONFIG.email,
      'user[password]': CONFIG.password,
      policy_confirmed: '1',
      commit: 'Sign In',
    });
    const res = await client.post(`/${CONFIG.country}/niv/users/sign_in`, params.toString(), {
      headers: {
        'X-CSRF-Token': csrfToken,
        'Cookie': cookies,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      maxRedirects: 5,
    });
    const setCookie = res.headers['set-cookie'];
    if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');
    return true;
  } catch (e) {
    if (e.response && [200, 302].includes(e.response.status)) {
      const setCookie = e.response.headers['set-cookie'];
      if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');
      return true;
    }
    console.log('[ERR] Login:', e.message);
    return false;
  }
}

async function getScheduleIds() {
  const endpoints = [
    `/${CONFIG.country}/niv/account`,
    `/${CONFIG.country}/niv/dashboard`,
    `/${CONFIG.country}/niv`,
  ];
  for (const ep of endpoints) {
    try {
      const res = await client.get(ep, { headers: { Cookie: cookies } });
      const matches = [...res.data.matchAll(/\/schedule\/(\d+)\//g)];
      const ids = [...new Set(matches.map(m => m[1]))];
      if (ids.length > 0) {
        state.scheduleIds = ids;
        console.log('[OK] Schedule IDs найдены:', ids);
        return true;
      }
    } catch (e) { /* пробуем следующий endpoint */ }
  }
  return false;
}

// ── Проверка дат ──────────────────────────────────────────────────────────────
async function fetchDatesForId(scheduleId) {
  try {
    const res = await client.get(
      `/${CONFIG.country}/niv/schedule/${scheduleId}/appointment/days/${CONFIG.facilityId}.json?appointments[expedite]=false`,
      {
        headers: {
          Cookie: cookies,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${BASE_URL}/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`,
        },
      }
    );
    return Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    console.log(`[ERR] Даты для ${scheduleId}:`, e.message);
    return null;
  }
}

// Возвращает даты доступные ОДНОВРЕМЕННО для всех участников (пересечение)
async function checkAllDates() {
  const ids = state.scheduleIds || [];
  if (ids.length === 0) return [];

  const results = await Promise.all(ids.map(id => fetchDatesForId(id)));
  const valid = results.filter(r => Array.isArray(r));
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  // Пересечение: только даты у которых слоты есть для ВСЕХ ID
  const sets = valid.map(dates => new Set(dates.map(d => d.date)));
  const common = [...sets[0]].filter(date => sets.every(s => s.has(date)));
  console.log(`[INFO] ID1: ${valid[0].length} дат, ID2: ${valid[1]?.length ?? '?'} дат, общих: ${common.length}`);
  return common.map(date => ({ date }));
}

async function getTimeSlots(scheduleId, date) {
  try {
    const res = await client.get(
      `/${CONFIG.country}/niv/schedule/${scheduleId}/appointment/times/${CONFIG.facilityId}.json?date=${date}&appointments[expedite]=false`,
      {
        headers: {
          Cookie: cookies,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${BASE_URL}/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`,
        },
      }
    );
    return res.data?.available_times || [];
  } catch (e) {
    console.log('[ERR] Время:', e.message);
    return [];
  }
}

async function getCurrentAppointment() {
  const scheduleId = (state.scheduleIds || [])[0];
  if (!scheduleId) return null;
  try {
    const res = await client.get(`/${CONFIG.country}/niv/schedule/${scheduleId}`, {
      headers: { Cookie: cookies },
    });
    const m = res.data.match(/(\d{1,2}\s+\w+,\s+\d{4}),\s+(\d{2}:\d{2})/);
    if (m) return { date: m[1].trim(), time: m[2].trim() };
  } catch (e) {
    console.log('[ERR] getCurrentAppointment:', e.message);
  }
  return null;
}

// Конвертирует "26 August, 2026" -> "2026-08-26"
function toISODate(str) {
  const months = {
    January: '01', February: '02', March: '03', April: '04',
    May: '05', June: '06', July: '07', August: '08',
    September: '09', October: '10', November: '11', December: '12',
  };
  const m = str?.match(/(\d{1,2})\s+(\w+),?\s+(\d{4})/);
  if (!m) return null;
  const month = months[m[2]];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

// ── Бронирование ──────────────────────────────────────────────────────────────
async function bookOneAppointment(scheduleId, date, time) {
  try {
    const pageRes = await client.get(
      `/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`,
      { headers: { Cookie: cookies } }
    );
    const csrfMatch = pageRes.data.match(/csrf-token"\s+content="([^"]+)"/);
    if (csrfMatch) csrfToken = csrfMatch[1];

    const params = new URLSearchParams({
      authenticity_token: csrfToken,
      confirmed_limit_message: '1',
      use_consulate_appointment_capacity: 'true',
      'appointments[consulate_appointment][facility_id]': String(CONFIG.facilityId),
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
    });

    const res = await client.post(
      `/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`,
      params.toString(),
      {
        headers: {
          Cookie: cookies,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': csrfToken,
          Referer: `${BASE_URL}/${CONFIG.country}/niv/schedule/${scheduleId}/appointment`,
        },
        maxRedirects: 5,
      }
    );
    return [200, 302].includes(res.status);
  } catch (e) {
    console.log(`[ERR] Бронирование ${scheduleId}:`, e.message);
    return false;
  }
}

async function bookAll(date, time) {
  const results = [];
  for (const scheduleId of (state.scheduleIds || [])) {
    console.log(`[BOOKING] ID ${scheduleId}: ${date} ${time}`);
    const ok = await bookOneAppointment(scheduleId, date, time);
    results.push({ scheduleId, ok });
    if (state.scheduleIds.indexOf(scheduleId) < state.scheduleIds.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return results;
}

async function attemptBooking(targetDate) {
  const firstId = (state.scheduleIds || [])[0];
  const times = await getTimeSlots(firstId, targetDate);
  if (times.length === 0) {
    await sendTelegram('❌ Нет доступного времени для этой даты. Повторю при следующей проверке.');
    state.pendingBook = true; // оставляем флаг — попробуем снова
    return;
  }

  const results = await bookAll(targetDate, times[0]);
  const successCount = results.filter(r => r.ok).length;
  const total = results.length;

  if (successCount === total) {
    state.currentDate = targetDate;
    state.pendingBook = false;
    await sendTelegram(
      `✅ <b>Запись успешно перенесена!</b>\n\n` +
      `📅 Новая дата: <b>${targetDate}</b>\n` +
      `🕐 Время: <b>${times[0]}</b>\n` +
      `👫 Записаны: муж и жена\n\n` +
      `🔗 Проверь: https://ais.usvisa-info.com/en-uz/niv`
    );
    console.log('[SUCCESS] Забронировано:', targetDate, times[0]);
  } else if (successCount > 0) {
    state.pendingBook = false;
    await sendTelegram(
      `⚠️ <b>Частичная запись!</b>\n\n` +
      `📅 ${targetDate} 🕐 ${times[0]}\n` +
      `Записано ${successCount} из ${total}.\n\n` +
      `❗ Зайди на сайт и проверь вручную!\n` +
      `🔗 https://ais.usvisa-info.com/en-uz/niv`
    );
  } else {
    state.pendingBook = true; // повторим при следующем запуске
    await sendTelegram(`❌ Ошибка бронирования ${targetDate}. Повторю при следующей проверке.`);
  }
}

// ── Главная функция ───────────────────────────────────────────────────────────
async function run() {
  console.log(`[${new Date().toISOString()}] Запуск...`);

  await loadState();

  // Восстанавливаем сохранённые cookies из state
  if (state.cookies) cookies = state.cookies;

  // Проверяем сессию — входим только если она истекла
  const sessionOk = await isSessionValid();
  if (sessionOk) {
    console.log('[AUTH] Сессия активна, вход не нужен');
  } else {
    console.log('[AUTH] Сессия истекла, выполняю вход...');
    const loggedIn = await login();
    if (!loggedIn) {
      console.log('[ERR] Не удалось войти');
      await sendTelegram('⚠️ Бот не смог войти в систему. Возможно, изменился пароль или сессия заблокирована.');
      await saveState();
      return;
    }
    state.cookies = cookies; // сохраняем новую сессию
    console.log('[AUTH] Вход выполнен, сессия сохранена');
  }

  if (!state.scheduleIds || state.scheduleIds.length === 0) {
    const found = await getScheduleIds();
    if (!found) {
      console.log('[ERR] Не найдены Schedule ID');
      await saveState();
      return;
    }
  }

  // Обновляем текущую дату записи с сайта
  const appt = await getCurrentAppointment();
  if (appt) {
    const iso = toISODate(appt.date);
    if (iso && iso !== state.currentDate) {
      console.log(`[INFO] Дата записи изменилась: ${state.currentDate} → ${iso}`);
      state.currentDate = iso;
    }
  }

  // Читаем команды из Telegram (с учётом offset)
  const command = await checkTelegramCommands();
  if (command) console.log('[CMD]', command);

  // ── Обработка команд ────────────────────────────────────────────────────────
  if (command === 'HELP') {
    await sendTelegram(
      `🤖 <b>Visa Monitor — Посольство США, Ташкент</b>\n\n` +
      `<b>Команды:</b>\n` +
      `📋 <b>STATUS</b> — текущая запись\n` +
      `📅 <b>DATES</b> — все доступные даты\n` +
      `🔖 <b>BOOK</b> — начать бронирование ранней даты\n` +
      `✅ <b>BOOK_YES</b> — подтвердить и забронировать\n` +
      `❌ <b>CANCEL</b> — отменить ожидающее бронирование\n\n` +
      `⏱ Проверка каждые 5 минут.\n` +
      `Уведомление придёт, когда найдётся дата раньше <b>${state.currentDate}</b>.`
    );
    await saveState();
    return;
  }

  if (command === 'STATUS') {
    await sendTelegram(
      `📋 <b>Текущая запись в посольство США</b>\n\n` +
      `📅 Дата: <b>${appt?.date || state.currentDate}</b>\n` +
      `🕐 Время: <b>${appt?.time || '—'}</b>\n` +
      `👫 Заявители: муж и жена\n` +
      `🏢 Посольство: Ташкент\n\n` +
      `🔍 Ищу даты раньше <b>${state.currentDate}</b>\n` +
      (state.pendingBook ? `⏳ Режим автобронирования активен (CANCEL для отмены)` : '')
    );
    await saveState();
    return;
  }

  if (command === 'CANCEL') {
    state.pendingBook = false;
    await sendTelegram('❌ Автобронирование отменено. Продолжаю мониторинг.');
    await saveState();
    return;
  }

  if (command === 'DATES') {
    const dates = await checkAllDates();
    if (!dates || dates.length === 0) {
      await sendTelegram(`📅 <b>Доступные даты</b>\n\n❌ Свободных дат пока нет`);
    } else {
      const list = dates.slice(0, 20).map(d => {
        const earlier = d.date < state.currentDate;
        return `${earlier ? '✅' : '📌'} ${d.date}`;
      }).join('\n');
      await sendTelegram(
        `📅 <b>Все доступные даты (${dates.length} шт.):</b>\n\n${list}` +
        (dates.length > 20 ? `\n...и ещё ${dates.length - 20}` : '') +
        `\n\n✅ раньше твоей (${state.currentDate})\n📌 позже твоей`
      );
    }
    await saveState();
    return;
  }

  if (command === 'BOOK') {
    const dates = await checkAllDates();
    const earlier = (dates || []).filter(d => d.date < state.currentDate);
    if (earlier.length === 0) {
      state.pendingBook = true;
      await sendTelegram(
        `🔖 <b>Автобронирование включено.</b>\n\n` +
        `Сейчас нет дат раньше ${state.currentDate}.\n` +
        `Как только появятся — автоматически забронирую без лишних вопросов.\n\n` +
        `Отправь <b>CANCEL</b> для отмены.`
      );
    } else {
      const list = earlier.slice(0, 5).map(d => `• ${d.date}`).join('\n');
      state.pendingBook = true;
      await sendTelegram(
        `🔖 Найдены ранние даты:\n${list}\n\n` +
        `Отправь <b>BOOK_YES</b> чтобы забронировать <b>${earlier[0].date}</b>\n` +
        `или <b>CANCEL</b> для отмены.`
      );
    }
    await saveState();
    return;
  }

  if (command === 'BOOK_YES') {
    const dates = await checkAllDates();
    const earlier = (dates || []).filter(d => d.date < state.currentDate).sort((a, b) => a.date.localeCompare(b.date));
    if (earlier.length === 0) {
      state.pendingBook = true;
      await sendTelegram(
        `📭 Сейчас нет дат раньше ${state.currentDate}.\n` +
        `Автобронирование включено — сработает как только появятся.`
      );
    } else {
      await sendTelegram(`⏳ Бронирую <b>${earlier[0].date}</b>...`);
      await attemptBooking(earlier[0].date);
    }
    await saveState();
    return;
  }

  // ── Плановый мониторинг ─────────────────────────────────────────────────────
  console.log(`[INFO] Ищу даты раньше ${state.currentDate}...`);
  const dates = await checkAllDates();
  if (dates === null) { await saveState(); return; }

  const earlier = dates
    .filter(d => d.date && d.date < state.currentDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (earlier.length > 0) {
    const foundList = earlier.map(d => d.date);
    const lastList = [...(state.lastNotifiedDates || [])].sort();

    // Уведомляем только если даты изменились (защита от спама)
    const isNew = JSON.stringify(foundList.slice().sort()) !== JSON.stringify(lastList);
    if (isNew) {
      state.lastNotifiedDates = foundList;
      const list = foundList.slice(0, 10).map(d => `• ${d}`).join('\n');
      await sendTelegram(
        `🗓 <b>Найдены более ранние даты!</b>\n\nДоступные даты:\n${list}` +
        (foundList.length > 10 ? `\n...и ещё ${foundList.length - 10}` : '') +
        `\n\nТвоя текущая запись: <b>${state.currentDate}</b>\n\n` +
        (state.pendingBook
          ? `⏳ Автоматически бронирую <b>${foundList[0]}</b>...`
          : `Отправь <b>BOOK</b> чтобы включить автобронирование`)
      );
      console.log('[FOUND] Ранние даты:', foundList);
    } else {
      console.log('[INFO] Те же даты что и прошлый раз, уведомление не нужно');
    }

    // Если автобронирование включено — бронируем
    if (state.pendingBook) {
      await attemptBooking(foundList[0]);
    }
  } else {
    // Даты пропали — сбрасываем кэш уведомлений
    if ((state.lastNotifiedDates || []).length > 0) {
      state.lastNotifiedDates = [];
      console.log('[INFO] Ранние даты исчезли, кэш сброшен');
    }
    console.log('[INFO] Нет дат раньше', state.currentDate);
  }

  // Сохраняем актуальные cookies перед выходом
  state.cookies = cookies;
  await saveState();
}

run().catch(async e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
