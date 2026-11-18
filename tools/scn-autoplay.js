// 等分析完成 → 点开始 → 等一会儿（难度/跳转由 URL 的 autoplay / sim 负责）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 80; i++) {
    const b = document.getElementById('btn-start');
    if (b && b.offsetParent !== null) break;
    await sleep(400);
  }
  await sleep(300);
  document.getElementById('btn-start').click();
  await sleep(Number(window.__wait || 38000));
  return 'ok';
})()
