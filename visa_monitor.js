const axios = require('axios');
const https = require('https');

const CONFIG = {
  email: process.env.VISA_EMAIL || 'jxusenov@list.ru',
  password: process.env.VISA_PASSWORD || '212Aziko@Zuxa1989@',
  scheduleId: null,
  facilityId: 90,
  country: 'en-uz',
  checkInterval: 5 * 60 * 1000,
  telegramToken: process.env.TELEGRAM_TOKEN || '8763727275:AAH5oDZ_NxhJL7YgDxQwm0aCJUXp-E9sJpw',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '515561284'
};

const BASE_URL = 'https://ais.usvisa-info.com';

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

let cookies = '';
let csrfToken = '';

async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      chat_id: CONFIG.telegramChatId,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('[TG] Sent!');
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
  } catch (e) {
    console.log('[ERR] CSRF:', e.message);
  }
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

    if (res.status === 200 || res.status === 302) return true;
  } catch (e) {
    if (e.response && (e.response.status === 200 || e.response.status === 302)) {
      const setCookie = e.response.headers['set-cookie'];
      if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');
      return true;
    }
    console.log('[ERR] Login:', e.message);
  }
  return false;
}

async function getScheduleId() {
  const endpoints = [`/${CONFIG.country}/niv/account`, `/${CONFIG.country}/niv/dashboard`, `/${CONFIG.country}/niv`];
  for (const ep of endpoints) {
    try {
      const res = await client.get(ep, { headers: { 'Cookie': cookies } });
      const match = res.data.match(/\/schedule\/(\d+)\//);
      if (match) {
        CONFIG.scheduleId = match[1];
        console.log('[OK] Schedule ID:', CONFIG.scheduleId);
        return true;
      }
    } catch (e) {}
  }
  return false;
}

async function checkDates() {
  try {
    const res = await client.get(
      `/${CONFIG.country}/niv/schedule/${CONFIG.scheduleId}/appointment/days/${CONFIG.facilityId}.json?appointments[expedite]=false`,
      {
        headers: {
          'Cookie': cookies,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/${CONFIG.country}/niv/schedule/${CONFIG.scheduleId}/appointment`
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

async function run() {
  console.log(`[${new Date().toISOString()}] Checking...`);

  await getCsrfToken();
  const loggedIn = await login();
  if (!loggedIn) { console.log('[ERR] Login failed'); return; }

  if (!CONFIG.scheduleId) await getScheduleId();
  if (!CONFIG.scheduleId) { console.log('[ERR] No schedule ID'); return; }

  const dates = await checkDates();

  if (dates && dates.length > 0) {
    const list = dates.slice(0, 10).map(d => `• ${d.date}`).join('\n');
    const msg = `🗓 <b>Появились свободные даты!</b>\n\nДоступные даты:\n${list}\n\nСрочно заходи:\nhttps://ais.usvisa-info.com/en-uz/niv`;
    await sendTelegram(msg);
    console.log('[FOUND] Dates available!', dates.slice(0, 3).map(d => d.date));
  } else {
    console.log('[INFO] No dates available');
  }
}

run();
