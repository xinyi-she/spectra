#!/usr/bin/env python3
"""
抓取 osu!mania 4K 谱面（仅文本，不下音频）
------------------------------------------------------------------
用途：统计真实谱面的节奏/键位规律，作为自动排谱的先验。
只下载 .osu 文本（每个约 50KB），不下载音频、不重新分发。

数据源：osu.direct 公共镜像
  - 搜索：/api/v2/search?q=...&mode=3
  - 单谱：/api/osu/{beatmapId}
"""
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "_charts")
UA = "spectra-chart-research/1.0 (offline pattern statistics)"
BASE = "https://osu.direct"

# 用不同关键词换出不同结果（镜像不支持翻页）
QUERIES = list("abcdefgijklmnopqrstuvwxyz") + [
    "love", "night", "dream", "blue", "star", "fire", "rain", "sky",
    "dance", "heart", "moon", "sakura", "tokyo", "vocaloid", "touhou",
]


def get(url, timeout=30, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def collect():
    """收集 4K mania 谱面 id，按难度分档抽样，保证风格多样"""
    seen = set()
    cands = []
    for q in QUERIES:
        try:
            raw = get(f"{BASE}/api/v2/search?mode=3&limit=50&q={urllib.parse.quote(q)}")
            sets = json.loads(raw)
        except Exception as e:
            print(f"  [skip] q={q}: {e}")
            continue
        for b in sets if isinstance(sets, list) else []:
            for m in b.get("beatmaps") or []:
                if m.get("mode") != "mania" or m.get("cs") != 4:
                    continue
                if m["id"] in seen:
                    continue
                seen.add(m["id"])
                cands.append(
                    {
                        "id": m["id"],
                        "star": float(m.get("difficulty_rating") or 0),
                        "notes": int(m.get("count_circles") or 0),
                        "version": (m.get("version") or "")[:40],
                        "title": (b.get("title") or "")[:40],
                    }
                )
        print(f"  q={q:<10} 累计 4K 谱面 {len(cands)}")
        time.sleep(0.5)

    # 按星级分档，每档上限不同 —— 低星段落稀疏、高星段落密集，都要有
    buckets = [(0, 2.0, 15), (2.0, 3.2, 40), (3.2, 4.2, 55), (4.2, 5.0, 55), (5.0, 5.9, 45), (5.9, 9, 25)]
    picked = []
    for lo, hi, cap in buckets:
        pool = [c for c in cands if lo <= c["star"] < hi and 150 <= c["notes"] <= 4000]
        pool.sort(key=lambda c: -c["notes"])
        picked.extend(pool[:cap])
        print(f"  {lo}~{hi} 星：候选 {len(pool)}，取 {min(len(pool), cap)}")
    return picked


def main():
    only_scan = "--scan" in sys.argv
    os.makedirs(OUT, exist_ok=True)
    print("收集候选…")
    picked = collect()
    print(f"\n共选中 {len(picked)} 个谱面")
    if only_scan:
        io.open(os.path.join(ROOT, "_picked.json"), "w", encoding="utf-8").write(
            json.dumps(picked, ensure_ascii=False, indent=1)
        )
        return

    ok = 0
    fail = 0
    for i, c in enumerate(picked, 1):
        path = os.path.join(OUT, f"{c['id']}.osu")
        if os.path.exists(path) and os.path.getsize(path) > 2000:
            ok += 1
            continue
        try:
            txt = get(f"{BASE}/api/osu/{c['id']}")
            if "osu file format" not in txt[:40]:
                raise ValueError("不是谱面文件")
            io.open(path, "w", encoding="utf-8", newline="\n").write(txt)
            ok += 1
            if i % 10 == 0:
                print(f"  {i}/{len(picked)}  已存 {ok}")
        except Exception as e:
            fail += 1
            print(f"  [fail] {c['id']} {c['version']}: {e}")
        time.sleep(0.45)
    print(f"\n完成：{ok} 个成功，{fail} 个失败 → {OUT}")


if __name__ == "__main__":
    main()
