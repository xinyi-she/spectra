# SPECTRA · 音游锻造所

**▶ [在线试玩](https://xinyi-she.github.io/spectra/)** · 内置示例曲打开即玩

上传任意音频，浏览器现场分析节拍、生成 EASY / NORMAL / HARD 三档 4K 谱面，直接开打。
规则参考 [Sparebeat](https://sparebeat.com/)：四条轨道，`D F J K` 击打，长按接长条，
特殊音符配合空格。全程本地运算，音频不上传服务器。

## 运行

模块化 + `fetch` 需要 http 服务（不能直接双击 html）。

**最省事：双击 `启动.bat`** —— 自动找可用的 Python、启动服务、打开浏览器。

命令行方式：

```bash
cd beatforge
python tools/serve.py 8777      # 浏览器会自动打开 http://127.0.0.1:8777/
```

> Windows 上 `python` 可能指向 Microsoft Store 的占位程序（`where python` 里带
> `WindowsApps` 就是踩坑了，敲命令只会弹商店）。这种情况直接用 `启动.bat` 绕开。

## 加歌

1. **曲库** —— 首页点卡片，内置示例曲（程序合成，CC0）开箱即用
2. **本地上传** —— 拖入 MP3 / WAV / M4A / OGG / FLAC，分析结果存进浏览器（IndexedDB），
   刷新、关浏览器都还在，最多保留 20 首
3. **B 站链接** —— 粘贴 `BV` 号或 `b23.tv` 短链，本地服务解析下载音轨并缓存
   （需要 `tools/serve.py`；静态部署上这一项不可用）

首页还有 **我的记录**：每首歌分难度保存最好成绩、评级、最大连击，卡片左上角显示最好评级。
首页右上角「**B站转 MP3**」（`/convert.html`）可以把投稿批量转成本地文件下载。

## 玩法

| 元素 | 说明 |
| --- | --- |
| 按键 | 默认 `D F J K`，设置里可改；特殊音符需同时按 `空格` |
| 横向长条 | 单键击打，比轨道窄，不会挡住判定线 |
| 白边星标条 | 特殊音符，空格配合命中 → 分数 ×2 |
| 长条 | 按住头部，在尾端松手，判定看松手时机 |
| 判定 | JUST ±48ms（100%）、RUSH 偏早 / COOL 偏晚 ±145ms（50%）、MISS（0） |
| 分数 | 满分 1,000,000，按音符权重均分 |
| 评级 | SSS 100万 / SS 95万 / S 90万 / AAA 80万 / AA 75万 / A 70万 / B+ 65万 / B 60万 / C 50万 / D |

设置项：主题（日落 / 海洋 / 森林 / 雪原）、按键映射、音乐 / 打击音音量、下落速度、
判定偏移、镜像、空打惩罚、自动演示。下落速度只改视觉，不影响音频与节奏。

## 谱面怎么来的

不调用外部模型，纯信号处理 + 规则编排：多频段谱通量找击打点 → 在整条 BPM 轴上做
tempo-octave 搜索（拍点与小节的周期一起看）→ YIN 从混音里测基频 → **有唱的小节按音节
排节奏型、没唱的小节按鼓点** → 按真实谱面统计出的语汇排键位，长条只写在接得住的位置。
同一首音频每次生成的谱面一致（随机种子由 BPM + 时长决定）。

做法、参数、以及每条规则的实测数据都在 **[docs/DESIGN.md](docs/DESIGN.md)**，
包括和 Sparebeat 官方谱面、osu!mania 谱面的逐项对比。

## 目录

```
index.html           页面结构（首页 / 准备页 / 游玩 / 结算）
css/style.css        全部样式与 4 套主题
js/analyzer.js       频谱分析、onset 拾取、BPM 与拍点
js/pitch.js          YIN 基频检测
js/chart.js          三档难度谱面生成
js/game.js           判定 / 计分 / Canvas 渲染
js/app.js            屏幕流转、上传、设置、结算、记录
js/audio.js          AudioContext 播放、精确时钟、打击音
js/analyze.worker.js Web Worker，分析时不卡界面
assets/demo/         演示曲 mp3 + 封面
tools/               本地服务、B 站解析、谱面蒸馏与度量脚本
docs/DESIGN.md       生成流程与实测记录
```

## 部署

仓库根目录就是站点根，推到 GitHub 后 **Settings → Pages** 选 `main` / `/ (root)` 即可。
`.nojekyll` 已放好，所有资源都是相对路径，挂在 `/<仓库名>/` 子路径下也能跑。

静态托管上能玩：内置示例曲、本地上传、三档难度、记录与评级。不能用的只有
B 站链接提取（会被 CORS 拦住，需要 `tools/serve.py` 代理），页面会自动隐藏入口。

仓库里**不放任何 B 站投稿的音轨和封面**（版权 + 体积），`.gitignore` 已配好。
把自己的歌放上 Pages：先 `python tools/bili_audio.py <BV号> --out assets/demo/mysong`
抓成本地文件，再把条目加进 `js/app.js` 顶部的 `LIBRARY_SEED`。能不能公开托管取决于原作者授权。

## 致谢

玩法参考 [Sparebeat](https://sparebeat.com/)；判定与键位语汇参考 osu!mania 4K 社区谱面。
内置示例曲 `Spectra Loop` 由脚本合成，CC0。
