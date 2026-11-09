importScripts('config.js');

const API = self.POTEHA_CONFIG.SERVER_URL.replace(/\/+$/, '');

async function api(path, key, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, data: { error: 'offline' } };
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  return { status: res.status, data };
}

async function getKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey || '';
}

async function balance() {
  const key = await getKey();
  if (!key) return { ok: false, error: 'no_key' };
  const r = await api('/api/balance', key);
  return r.status === 200 ? { ok: true, ...r.data } : { ok: false, ...r.data, error: r.data.error || 'http_' + r.status };
}

async function runExport(tabId, format, host) {
  const key = await getKey();
  if (!key) return { ok: false, error: 'no_key' };

  // 1. Reserve tokens on the server.
  const spend = await api('/api/spend', key, { format, host });
  if (spend.status !== 200) return { ok: false, ...spend.data, error: spend.data.error || 'http_' + spend.status };

  // 2. Run the extractor in every frame and wait for its verdict.
  let result = { ok: false, error: 'unknown' };
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({
      target, world: 'MAIN',
      func: (f) => { window.__potehaSTLFormat = f; },
      args: [format],
    });
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['extractor.js'] });
    const frames = await chrome.scripting.executeScript({
      target, world: 'MAIN',
      func: async () => {
        for (let i = 0; i < 1200; i++) {
          if (window.__potehaSTLDone) return window.__potehaSTLDone;
          await new Promise((r) => setTimeout(r, 100));
        }
        return { ok: false, error: 'timeout' };
      },
    });
    const all = frames.map((f) => f.result).filter(Boolean);
    result = all.find((r) => r.ok)
      || all.find((r) => r.error && r.error !== 'no_scene')
      || all[0]
      || result;
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) };
  }

  // 3. Confirm the charge, or get the tokens back if nothing was exported.
  const fin = await api('/api/finish', key, { spend_id: spend.data.spend_id, ok: !!result.ok });
  return {
    ...result,
    cost: spend.data.cost,
    refunded: !!fin.data.refunded,
    balance: fin.data.balance ?? spend.data.balance,
    bot_url: spend.data.bot_url,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    if (msg.type === 'balance') return balance();
    if (msg.type === 'export') return runExport(msg.tabId, msg.format, msg.host);
    return { ok: false, error: 'bad_message' };
  };
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
