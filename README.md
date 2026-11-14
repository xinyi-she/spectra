# [link](https://xinyi-she.github.io/spectra/)

# SPECTRA · 音游锻造所

上传任意音频（MP3 / WAV / M4A / OGG / FLAC），浏览器里现场分析节拍、生成 EASY / NORMAL / HARD
三档 4K 谱面，直接开打。规则参考 [Sparebeat](https://sparebeat.com/)，全程本地运算，音频不上传服务器。

## 运行

模块化 + `fetch` 需要 http 服务（不能直接双击 html）。

**最省事：双击 `启动.bat`** —— 自动找可用的 Python、启动服务、打开浏览器。

命令行方式：

```bash
cd beatforge
python tools/serve.py 8777      # 浏览器会自动打开 http://127.0.0.1:8777/
```

参数：`python tools/serve.py [端口] [--no-open]`。重复执行不会起第二个实例，
检测到端口上已有本服务时直接复用并打开浏览器。

### 敲了命令但网页没反应？

Windows 上最常见的坑：`python` 命令指向的是 **Microsoft Store 的占位程序**
（`AppData\Local\Microsoft\WindowsApps\python.exe` 是个重定向器，不是真 Python），
敲下去只会弹应用商店、什么都不执行。判断方法：

```bash
where python        # 输出里有 WindowsApps\python.exe 就是踩坑了
python --version    # 没有版本号输出 = 没装真正的 Python
```

两种解法：

1. 双击 `启动.bat`（推荐，会绕开占位程序）
2. 装一个真 Python（python.org，安装时勾选 *Add python.exe to PATH*）

其它排查：端口被别的软件占用就换一个，例如 `python tools/serve.py 8899`；
服务端日志在 `tools/server.log`。

## 三种进歌方式

1. **曲库**：首页直接点卡片（内置两首 B 站投稿转出的音频）
2. **本地上传**：拖入 / 选择 MP3、WAV、M4A、OGG、FLAC
3. **B 站链接**：粘贴 `https://www.bilibili.com/video/BV…`、`BV 号` 或 `b23.tv` 短链，
   本地服务会解析、下载音轨（192kbps）并缓存到 `assets/cache/<BV号>/`，之后秒开

> 浏览器直连 B 站会被 CORS 和 Referer 校验拦住，所以这一步必须由 `tools/serve.py` 代理。
> 用 `python -m http.server` 也能玩曲库和上传，但 B 站链接会提示接口不可用。

首页还有 **我的记录**：每首歌按 EASY / NORMAL / HARD 分别保存最好成绩、评级、最大连击，
曲库卡片左上角会显示最好评级。数据都在 localStorage（`spectra.records`），可一键清空。

## B站转 MP3 工具页

首页右上角「**B站转 MP3**」，或直接开 `/convert.html`。

- 一次粘贴多个链接（换行 / 空格分隔都行），逐个解析
- 卡片显示封面、标题、UP 主、时长、文件大小、码率
- 「下载 MP3」存到本地，文件名是 `标题 - UP主.mp3`
- 「打音游」带着这首直接进游戏（等价于 `?bili=BV号`）
- 转换记录存 localStorage，下次打开可直接重新下载
- 音轨缓存在 `assets/cache/<BV号>/`，同一首再来一次秒出

错误信息做了翻译：BV 号写错、稿件已删、私密视频、审核中都会给出具体原因，
不会冒出 `KeyError: 'data'` 这种半截报错。

> 依赖 `tools/serve.py`。静态部署（GitHub Pages）上会直接提示「本地服务未连接」。

## B站转 MP3 工具页

首页右上角「**B站转 MP3**」，或直接开 `/convert.html`。

- 一次粘贴多个链接（换行 / 空格分隔都行），逐个解析
- 卡片显示封面、标题、UP 主、时长、文件大小、码率
- 「下载 MP3」存到本地，文件名是 `标题 - UP主.mp3`
- 「打音游」带着这首直接进游戏（等价于 `?bili=BV号`）
- 转换记录存 localStorage，下次打开可直接重新下载
- 音轨缓存在 `assets/cache/<BV号>/`，同一首再来一次秒出

错误信息做了翻译：BV 号写错、稿件已删、私密视频、审核中都会给出具体原因，
不会冒出 `KeyError: 'data'` 这种半截报错。

> 依赖 `tools/serve.py`。静态部署（GitHub Pages）上会直接提示「本地服务未连接」。

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

设置项：主题（日落 / 海洋 / 森林 / 雪原）、按键映射、音乐 / 打击音音量、下落速度、判定偏移、
镜像、空打惩罚（Bind 模式）、自动演示。最高分存在 localStorage。

**下落速度只改视觉**：音符从顶部滑到判定线的时间 = 1.75 / 速度，音频播放速率不变（不改音高、不改节奏）。
准备页拖动滑杆即可，游戏中也支持 `-` / `=` 实时微调。

## 谱面是怎么「AI 生成」的

`js/analyzer.js` + `js/chart.js`，不调用外部模型，纯信号处理 + 规则编排：

1. **STFT**：单声道 → 汉宁窗 FFT（44.1/48k 下 2048 点，hop ≈ 23ms）
2. **多频段谱通量**：bass / low / mid / high / air 五个频段分别做正向差分，各频段按 p97 归一后加权求和 → 击打强度曲线
3. **峰值拾取**：自适应阈值（局部均值 ×1.18）+ 局部极大 + 55ms 最小间隔 → 音符候选点，并标注频段特征（kick / snare / hat）
4. **BPM**：自相关做粗估 → 用「相位相干」精修（这一步很关键，129.3 → 130.0 的偏差会让整首歌漂 2 拍）→ 全拍搜索确定拍点相位 → 最小二乘拟合整曲网格
5. **吸附到网格**：原始 onset 相对拍点有 ±20ms 抖动（实测平均 22.6ms 偏差），直接排谱会显得「松 / 慢半拍」。所以先按 1/4（EASY/NORMAL）或 1/8（HARD）拍吸附、同格只留最强音。吸附后偏差降到 7.8ms，音符 100% 落在网格上
6. **强度曲线 → 密度**：按小节统计 RMS（响度）并平滑归一化成 0..1，混入该小节的击打点数量；
   每小节的目标密度 = 在该难度的「安静 NPS」和「高潮 NPS」之间插值 —— 主歌留白、副歌加密，密度和响度的相关系数实测 0.77~0.96
7. **谱面编排**：按 4 拍分小节，依小节音符数从动机库挑键位走向；选音时**按重要度排序**（强拍优先占位）；
   小节没填到目标密度时，按 1/8（或 1/16）空槽的击打强度补连打；高潮段额外补双押；留白处生成长条，重音处生成特殊音符；
   最后用 1 秒滑动窗口限制 NPS（3.6 / 6.2 / 11.8）保证可打

难度等级由实际 NPS 反推（同一首歌每次生成结果一致，随机种子由 BPM + 时长决定）。

## 目录

```
index.html            页面结构（首页 / 准备页 / 游玩 / 结算）
css/style.css         全部样式与 4 套主题
js/fft.js             radix-2 FFT、汉宁窗、可复现随机数
js/analyzer.js        频谱分析、onset 拾取、BPM 与拍点
js/chart.js           三档难度谱面生成
js/audio.js           AudioContext 播放、精确时钟、频谱、打击音合成
js/game.js            判定 / 计分 / Canvas 渲染 / 特效
js/app.js             屏幕流转、上传、设置、结算、记录
js/analyze.worker.js  Web Worker，避免分析时卡住界面
assets/demo/          演示曲 mp3 + 封面
tools/serve.py        本地服务：静态文件 + /api/bili/resolve 解析接口
tools/bili_audio.py   B 站视频 → mp3 + 封面（离线批量抓取用）
tools/cdp.mjs         无头 Edge 调试驱动（截图 / 执行 JS / 抓控制台）
```

