// 进入 Spectra Loop / HARD，跑几秒后截图（用于检查长条观感）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
const card = document.querySelector('#song-grid .song-card');
if (card) card.click();
await sleep(600);
const diffs = [...document.querySelectorAll('#diff-list button, #diff-list .diff-btn, #diff-list [role=button]')];
const hard = diffs.find((d) => /HARD|狂暴/i.test(d.textContent)) || diffs[diffs.length - 1];
if (hard) hard.click();
await sleep(300);
const auto = document.getElementById('opt-auto');
if (auto && auto.dataset.on !== 'true') auto.click();
document.getElementById('btn-start').click();
await sleep(Number(window.__wait || 13000));
})()
