const status = document.getElementById('status');

for (const btn of document.querySelectorAll('button[data-format]')) {
  btn.addEventListener('click', async () => {
    const format = btn.dataset.format;
    status.textContent = 'Экспортирую…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const target = { tabId: tab.id, allFrames: true };
      await chrome.scripting.executeScript({
        target, world: 'MAIN',
        func: (f) => { window.__threeRipFormat = f; },
        args: [format],
      });
      await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['extractor.js'] });
      status.textContent = 'Готово, итог в углу страницы.';
      setTimeout(() => window.close(), 1200);
    } catch (e) {
      status.textContent = 'Не удалось: ' + (e.message || e);
    }
  });
}
