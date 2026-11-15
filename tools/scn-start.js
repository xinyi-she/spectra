// 点"开始"，等一段时间后截图（检查开场缓冲/倒计时）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const wait = Number(window.__wait || 4600);
  document.getElementById('btn-start').click();
  await sleep(wait);
  return 'ok';
})()
