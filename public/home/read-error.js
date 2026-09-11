export function createReadError(message, retry) {
  const box = document.createElement('div'); box.className = 'empty-state'; box.style.gridColumn = '1 / -1';
  const text = document.createElement('p'); text.textContent = `读取失败：${message}`;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'today-button'; button.textContent = '重新读取';
  button.addEventListener('click', async () => { button.disabled = true; try { await retry(); } finally { button.disabled = false; } });
  box.append(text, button); return box;
}
