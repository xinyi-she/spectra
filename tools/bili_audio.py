#!/usr/bin/env python3
"""
B 站视频 → 音频 + 封面（给 SPECTRA 做演示曲用）

用法:
    python tools/bili_audio.py BV1k3S7BkEag
    python tools/bili_audio.py BV1k3S7BkEag --out assets/demo/tenfold

说明:
  * 走 playurl 的 DASH 接口，不登录也能拿到 m4a 音轨（最高 192kbps）
  * 如果装了 imageio-ffmpeg / 系统 ffmpeg，会顺手转成 mp3 并裁 16:10 封面
  * 仅用于个人技术演示，请尊重原作者版权
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
REFERER = "https://www.bilibili.com/"


def api(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def find_ffmpeg():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        for name in ("ffmpeg", "ffmpeg.exe"):
            from shutil import which

            p = which(name)
            if p:
                return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bvid")
    ap.add_argument("--out", default=None, help="输出前缀，默认 assets/demo/<bvid>")
    ap.add_argument("--keep-m4a", action="store_true")
    args = ap.parse_args()

    info = api(f"https://api.bilibili.com/x/web-interface/view?bvid={args.bvid}")["data"]
    cid = info["pages"][0]["cid"]
    title = info["title"]
    print(f"标题: {title}")
    print(f"UP: {info['owner']['name']}  时长: {info['duration']}s  cid: {cid}")

    play = api(
        f"https://api.bilibili.com/x/player/playurl?bvid={args.bvid}&cid={cid}&fnval=16&fnver=0&fourk=1"
    )
    audios = (play.get("data") or {}).get("dash", {}).get("audio") or []
    if not audios:
        sys.exit("没有拿到音频流（可能需要登录 cookie 或该视频受限）")
    audio = sorted(audios, key=lambda a: a["id"])[-1]  # 30280 = 192kbps
    print(f"音轨 id={audio['id']} 带宽={audio['bandwidth']}")

    out = args.out or f"assets/demo/{args.bvid}"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    req = urllib.request.Request(
        audio["baseUrl"],
        headers={"User-Agent": UA, "Referer": f"https://www.bilibili.com/video/{args.bvid}", "Origin": "https://www.bilibili.com"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    m4a = out + ".m4a"
    with open(m4a, "wb") as f:
        f.write(data)
    print(f"已保存音轨 {m4a} ({len(data)/1048576:.1f} MB)")

    # 封面
    cover = out + "-cover.jpg"
    try:
        req = urllib.request.Request(info["pic"], headers={"User-Agent": UA, "Referer": REFERER})
        with urllib.request.urlopen(req, timeout=30) as r:
            with open(cover, "wb") as f:
                f.write(r.read())
        print(f"已保存封面 {cover}")
    except Exception as e:
        print(f"封面下载失败: {e}")

    ff = find_ffmpeg()
    if ff:
        mp3 = out + ".mp3"
        subprocess.run(
            [ff, "-y", "-i", m4a, "-codec:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", mp3],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if os.path.exists(mp3):
            print(f"已转码 {mp3} ({os.path.getsize(mp3)/1048576:.1f} MB)")
        if not args.keep_m4a and os.path.exists(mp3):
            try:
                os.remove(m4a)
            except OSError:
                print("（m4a 未能删除，可手动清理）")
    else:
        print("未找到 ffmpeg，保留 m4a（浏览器同样能解码）")

    meta = {
        "bvid": args.bvid,
        "title": title,
        "owner": info["owner"]["name"],
        "duration": info["duration"],
        "cover": info["pic"],
        "desc": info.get("desc", "")[:400],
    }
    with open(out + "-meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("完成 →", out + ".mp3")


if __name__ == "__main__":
    main()
