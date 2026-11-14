#!/usr/bin/env python3
"""
生成内置示例曲《Spectra Loop》：128 BPM / A 小调 / 90 秒
全部用正弦、锯齿、噪声合成，无任何采样，可自由分发（CC0）。
产物：assets/demo/spectra-demo.mp3 + assets/demo/spectra-demo.jpg

用法: python tools/make_demo.py
"""
import os
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SR = 44100
BPM = 128
BEAT = 60 / BPM
BAR = BEAT * 4
BARS = 48
TOTAL = int(BARS * BAR * SR) + SR
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "assets", "demo")

rng = np.random.default_rng(20261022)


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def exp_env(n, tau, attack=0.002):
    t = np.arange(n) / SR
    e = np.exp(-t / tau)
    a = max(1, int(attack * SR))
    if a > 1 and a < n:
        e[:a] *= np.linspace(0, 1, a)
    return e


def lowpass(x, a):
    """一阶低通（a 越小越闷）"""
    y = np.empty_like(x)
    prev = 0.0
    for i in range(len(x)):
        prev += a * (x[i] - prev)
        y[i] = prev
    return y


def kick():
    n = int(0.36 * SR)
    t = np.arange(n) / SR
    f = 48 + 100 * np.exp(-t / 0.028)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * exp_env(n, 0.085)
    x += rng.normal(0, 1, n) * exp_env(n, 0.003) * 0.25
    return x * 0.95


def snare():
    n = int(0.24 * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    body = np.sin(2 * np.pi * 190 * t) * exp_env(n, 0.05)
    return (noise * exp_env(n, 0.075) * 0.55 + body * 0.45) * 0.7


def hat(open_=False):
    n = int((0.12 if open_ else 0.05) * SR)
    noise = rng.normal(0, 1, n)
    hp = np.diff(np.concatenate([[0.0], noise]))  # 简易高通
    return hp * exp_env(n, 0.055 if open_ else 0.013) * 0.3


def bass(f, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    saw = 2 * ((f * t) % 1.0) - 1
    sub = np.sin(2 * np.pi * f * t)
    env = np.minimum(1, t / 0.006) * np.exp(-t / 0.3)
    x = (saw * 0.45 + sub * 0.85) * env
    return lowpass(x, 0.16) * 0.62


def pluck(f, dur, bright=0.55):
    n = int(dur * SR)
    t = np.arange(n) / SR
    saw = 2 * ((f * t) % 1.0) - 1
    sq = np.sign(np.sin(2 * np.pi * f * t))
    x = sq * bright + saw * (1 - bright)
    return x * np.exp(-t / 0.11) * 0.2


def pad(freqs, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for f in freqs:
        for det in (-0.007, 0.0, 0.007):
            x += 2 * ((f * (1 + det) * t) % 1.0) - 1
    x /= len(freqs) * 3
    env = np.minimum(1, t / 0.22) * np.clip((dur - t) / 0.28, 0, 1)
    return lowpass(x, 0.09) * env * 0.2


# ---- A 小调：Am - F - C - G ----
CHORDS = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
ROOTS = [45, 41, 36, 43]

L = np.zeros(TOTAL)
R = np.zeros(TOTAL)


def add(sig, t, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i < 0 or i >= TOTAL:
        return
    n = min(len(sig), TOTAL - i)
    L[i : i + n] += sig[:n] * gain * (1 - pan * 0.4)
    R[i : i + n] += sig[:n] * gain * (1 + pan * 0.4)


kick_s = kick()
snare_s = snare()
hat_s = hat()
ohat_s = hat(True)

for b in range(BARS):
    t0 = b * BAR
    ch = CHORDS[b % 4]
    root = ROOTS[b % 4]

    intro = b < 4
    groove = 4 <= b < 8
    build = 8 <= b < 16
    chorus = 16 <= b < 24 or 28 <= b < 44
    brk = 24 <= b < 28
    outro = b >= 44

    if not brk and not outro:
        for k in range(4):
            add(kick_s, t0 + k * BEAT, 0.9)
        add(snare_s, t0 + BEAT, 0.6, -0.1)
        add(snare_s, t0 + 3 * BEAT, 0.6, 0.1)
    if outro:
        add(kick_s, t0, 0.7)

    # 8 分踩镲
    for k in range(8):
        if intro and k % 2 == 0:
            continue
        add(hat_s if k % 2 == 0 else ohat_s, t0 + k * BEAT / 2, 0.9 if k % 2 else 0.6, 0.25)

    # 贝斯
    if groove or build or chorus or brk:
        for k in range(8):
            f = midi(root + (12 if k in (3, 6) else 0))
            add(bass(f, BEAT * 0.42), t0 + k * BEAT / 2, 0.85)
    if chorus:
        for k in range(8):
            if k % 2 == 1:
                add(bass(midi(root + 12), BEAT * 0.3), t0 + k * BEAT / 2, 0.4)

    # 和弦垫 + 反拍重音
    if build or chorus or brk or outro:
        add(pad([midi(n) for n in ch], BAR * 0.96), t0, 0.75)
    if build or chorus:
        for k in range(4):
            for n in ch:
                add(pluck(midi(n + 12), 0.16), t0 + (k + 0.5) * BEAT, 0.5, 0.15)

    # 琶音：build/chorus 用 16 分，break 用 8 分
    if build or chorus or brk:
        step = BEAT / 4 if (chorus or build) else BEAT / 2
        cnt = int(BAR / step)
        pattern = [0, 1, 2, 3, 2, 1, 2, 1]
        for k in range(cnt):
            n = ch[pattern[k % len(pattern)] % 3] + (12 if (k % 8) >= 4 else 0)
            if chorus:
                n += 12
            add(pluck(midi(n), step * 1.6, 0.65), t0 + k * step, 0.42, -0.2 if k % 2 else 0.2)

# 结尾淡出
fade = int(2.5 * SR)
env = np.linspace(1, 0, fade) ** 1.5
L[-fade:] *= env
R[-fade:] *= env

# 归一化到 -1.2 dBFS
peak = max(np.abs(L).max(), np.abs(R).max())
g = 0.87 / max(peak, 1e-9)
L *= g
R *= g

os.makedirs(OUT_DIR, exist_ok=True)
wav_path = os.path.join(OUT_DIR, "spectra-demo.wav")
pcm = np.stack([L, R], axis=1)
pcm = np.clip(pcm, -1, 1)
with wave.open(wav_path, "wb") as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SR)
    f.writeframes((pcm * 32767).astype("<i2").tobytes())
print("wav", wav_path, os.path.getsize(wav_path) // 1024, "KB")

mp3_path = os.path.join(OUT_DIR, "spectra-demo.mp3")
ff = None
try:
    import imageio_ffmpeg

    ff = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    pass
if ff:
    subprocess.run(
        [ff, "-y", "-i", wav_path, "-codec:a", "libmp3lame", "-b:a", "192k", mp3_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print("mp3", mp3_path, os.path.getsize(mp3_path) // 1024, "KB")
    try:
        os.remove(wav_path)
    except OSError:
        pass

# ---- 封面：抽象渐变 + 同心圆 + 扫描线 ----
W, H = 640, 400
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
nx, ny = xx / W, yy / H
base = np.zeros((H, W, 3), np.float32)
for i, (cx, cy, col, rad) in enumerate(
    [(0.28, 0.22, (150, 120, 250), 0.95), (0.78, 0.72, (244, 114, 182), 0.85), (0.5, 1.05, (56, 189, 248), 0.7)]
):
    d = np.sqrt((nx - cx) ** 2 + (ny - cy) ** 2) / rad
    glow = np.clip(1 - d, 0, 1) ** 2
    for c in range(3):
        base[:, :, c] += glow * col[c] * 0.55
base += 12

d2 = np.sqrt((nx - 0.5) ** 2 + (ny - 0.46) ** 2)
rings = (np.sin(d2 * 130 - 1.2) * 0.5 + 0.5) ** 6
base += (rings * 26)[:, :, None]
# 扫描线
base *= (1 - 0.16 * (np.sin(yy * 1.6) * 0.5 + 0.5))[:, :, None]
# 暗角
vig = np.clip(1.25 - 1.05 * np.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2) * 1.5, 0, 1)
base *= vig[:, :, None]
img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
img = img.filter(ImageFilter.GaussianBlur(0.4))
d = ImageDraw.Draw(img)
for i in range(9):
    x = 60 + i * 62
    h = 20 + (i * 37) % 90
    d.rounded_rectangle([x, 300 - h // 2, x + 26, 300 + h // 2], radius=13, fill=(255, 255, 255, 70))
img.save(os.path.join(OUT_DIR, "spectra-demo.jpg"), quality=90)
print("cover ok")
