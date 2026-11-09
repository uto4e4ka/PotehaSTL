const $ = (id) => document.getElementById(id);
const status = $('status');
const DEFAULT_BOT = 'https://t.me/';

const setStatus = (text, err = false) => { status.textContent = text; status.className = err ? 'err' : ''; };
const send = (msg) => chrome.runtime.sendMessage(msg);

const plural = (n) => {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return n + ' токен';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return n + ' токена';
  return n + ' токенов';
};

const ERRORS = {
  no_key: 'Нет ключа.',
  bad_key: 'Ключ не подходит. Возьмите актуальный в боте (/key).',
  no_tokens: 'Не хватает токенов. Пополните баланс в боте.',
  offline: 'Сервер PotehaSTL недоступен. Проверьте интернет или адрес в config.js.',
  no_scene: 'На странице не нашлась сцена three.js. Перезагрузите страницу и попробуйте снова.',
  no_meshes: 'Сцена найдена, но в ней нет мешей.',
  timeout: 'Экспорт не успел за 2 минуты.',
};
const explain = (e) => ERRORS[e] || ('Ошибка: ' + e);

let botUrl = DEFAULT_BOT;
function setBot(url) {
  if (url) botUrl = url;
  $('botLink').href = botUrl;
  $('buyLink').href = botUrl;
}

function show(view) {
  $('login').classList.toggle('hidden', view !== 'login');
  $('main').classList.toggle('hidden', view !== 'main');
}

function renderBalance(r) {
  setBot(r.bot_url);
  if (typeof r.balance === 'number') $('balance').innerHTML = 'баланс: <b>' + r.balance + '</b>';
  if (r.costs) {
    for (const el of document.querySelectorAll('[data-cost]')) el.textContent = plural(r.costs[el.dataset.cost]);
  }
}

async function refresh() {
  setStatus('');
  const r = await send({ type: 'balance' });
  if (r.ok) { renderBalance(r); show('main'); return; }
  renderBalance(r);
  $('balance').textContent = '';
  show('login');
  if (r.error !== 'no_key') setStatus(explain(r.error), true);
}

$('saveKey').addEventListener('click', async () => {
  const key = $('keyInput').value.trim();
  if (!key) return;
  await chrome.storage.local.set({ apiKey: key });
  $('keyInput').value = '';
  refresh();
});

$('logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.storage.local.remove('apiKey');
  refresh();
});

for (const btn of document.querySelectorAll('button[data-format]')) {
  btn.addEventListener('click', async () => {
    const buttons = document.querySelectorAll('button[data-format]');
    buttons.forEach((b) => { b.disabled = true; });
    setStatus('Экспортирую…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let host = '';
      try { host = new URL(tab.url).hostname; } catch (e) { /* chrome:// etc. */ }
      const r = await send({ type: 'export', tabId: tab.id, format: btn.dataset.format, host });
      renderBalance(r);
      if (r.ok) {
        setStatus(`Готово: ${r.file}\nСписано ${plural(r.cost)}.`);
      } else if (r.refunded) {
        setStatus(explain(r.error) + '\nТокены возвращены.', true);
      } else {
        setStatus(explain(r.error), true);
      }
    } catch (e) {
      setStatus(explain(String((e && e.message) || e)), true);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
}

setBot();
refresh();
