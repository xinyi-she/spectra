#!/usr/bin/env python3
"""
SPECTRA 本地服务器
  * 静态文件 + 关闭缓存（改完 JS 立刻生效）
  * GET /api/health                       健康检查
  * GET /api/bili/resolve?url=<B站链接>    解析并缓存音轨，返回本地音频/封面地址

用法: python tools/serve.py [port]
"""
import functools
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import traceback
import urllib.parse
import urllib.request
import webbrowser
from urllib.request import urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "assets", "cache")
LOG = os.path.join(ROOT, "tools", "server.log")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
MAX_DURATION = 60 * 12

_locks = {}
_locks_guard = threading.Lock()


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(msg.rstrip() + "\n")
    except Exception:
        pass
    try:
        sys.stderr.write(msg.rstrip() + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def lock_for(key):
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def http_json(url, referer="https://www.bilibili.com/"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def http_bytes(url, referer="https://www.bilibili.com/", timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def find_bvid(text):
    text = (text or "").strip()
    m = BV_RE.search(text)
    if m:
        return m.group(1)
    if "b23.tv" in text:
        url = text if text.startswith("http") else "https://" + text
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            m = BV_RE.search(r.geturl())
            if m:
                return m.group(1)
    return None


def find_ffmpeg():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def make_cover(src_bytes, dst):
    tmp = dst + ".src"
    with open(tmp, "wb") as f:
        f.write(src_bytes)
    try:
        from PIL import Image

        im = Image.open(tmp)
        w, h = im.size
        tw, th = 16, 10
        if w / h > tw / th:
            nw = int(h * tw / th)
            im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
        else:
            nh = int(w * th / tw)
            im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
        im.convert("RGB").resize((640, 400), Image.LANCZOS).save(dst, quality=86)
        os.remove(tmp)
    except Exception:
        os.replace(tmp, dst)


BILI_ERRORS = {
    -404: "视频不存在（BV 号写错了？或者稿件已被删除）",
    -403: "没有权限访问这个视频（可能是私密或需要登录）",
    -400: "请求参数不对，检查一下链接",
    62002: "稿件不可见（可能已被删除或设为私密）",
    62004: "稿件还在审核中，暂时拿不到音轨",
}


def bili_error(code, msg):
    """把 B 站错误码翻成人话，别把 KeyError 那种东西扔给前端"""
    try:
        code = int(code)
    except (TypeError, ValueError):
        code = 0
    if code in BILI_ERRORS:
        return BILI_ERRORS[code]
    if msg:
        return "B 站返回错误：%s（code %s）" % (msg, code)
    return "B 站接口返回异常（code %s）" % code


def with_file_info(meta):
    """补上音频文件的体积和格式，前端要用来显示"""
    audio = str(meta.get("audio") or "")
    try:
        meta["size"] = os.path.getsize(os.path.join(ROOT, audio.lstrip("/")))
    except OSError:
        meta["size"] = 0
    meta["format"] = "mp3" if audio.endswith(".mp3") else "m4a"
    return meta


def resolve(bvid):
    """下载并缓存一首 B 站音频，返回给前端的元信息"""
    folder = os.path.join(CACHE, bvid)
    meta_path = os.path.join(folder, "meta.json")
    with lock_for(bvid):
        if os.path.exists(meta_path):
            try:
                with open(meta_path, encoding="utf-8") as f:
                    meta = json.load(f)
                if os.path.exists(os.path.join(ROOT, meta["audio"].lstrip("/"))):
                    meta["cached"] = True
                    return with_file_info(meta)
            except Exception:
                log("[warn] 缓存元信息损坏，重新抓取 " + bvid)

        resp = http_json("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid)
        if resp.get("code") != 0:
            raise ValueError(bili_error(resp.get("code"), resp.get("message")))
        info = resp.get("data") or {}
        if not info.get("pages"):
            raise ValueError("拿不到这个视频的分 P 信息，可能已下架")

        duration = info.get("duration") or 0
        if duration > MAX_DURATION:
            raise ValueError("视频太长（%d 秒），最多支持 %d 分钟" % (duration, MAX_DURATION // 60))

        cid = info["pages"][0]["cid"]
        play = http_json(
            "https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%s&fnval=16&fnver=0&fourk=1"
            % (bvid, cid)
        )
        audios = ((play.get("data") or {}).get("dash") or {}).get("audio") or []
        if not audios:
            raise ValueError("这个视频没有可用音轨（可能需要登录或已下架）")
        best = sorted(audios, key=lambda a: a.get("bandwidth", 0))[-1]
        raw = http_bytes(best["baseUrl"], referer="https://www.bilibili.com/video/" + bvid)

        os.makedirs(folder, exist_ok=True)
        m4a = os.path.join(folder, "audio.m4a")
        with open(m4a, "wb") as f:
            f.write(raw)

        ff = find_ffmpeg()
        mp3 = os.path.join(folder, "audio.mp3")
        audio_rel = "/assets/cache/%s/audio.m4a" % bvid
        if ff:
            r = subprocess.run(
                [ff, "-y", "-i", m4a, "-codec:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", mp3],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if r.returncode == 0 and os.path.exists(mp3):
                audio_rel = "/assets/cache/%s/audio.mp3" % bvid
                try:
                    os.remove(m4a)
                except OSError:
                    pass

        cover_rel = ""
        try:
            pic = info.get("pic") or ""
            if pic.startswith("//"):
                pic = "https:" + pic
            make_cover(http_bytes(pic.replace("http://", "https://")), os.path.join(folder, "cover.jpg"))
            cover_rel = "/assets/cache/%s/cover.jpg" % bvid
        except Exception as e:
            log("[warn] 封面失败 %s: %s" % (bvid, e))

        meta = {
            "ok": True,
            "bvid": bvid,
            "title": info.get("title", bvid),
            "owner": (info.get("owner") or {}).get("name", ""),
            "duration": duration,
            "audio": audio_rel,
            "cover": cover_rel,
            "bitrate": best.get("bandwidth", 0),
            "cached": False,
        }
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=1)
        log("[ok] 抓取完成 %s %s" % (bvid, meta["title"][:30]))
        return with_file_info(meta)


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/health":
                self.send_json({"ok": True, "api": 1, "cache": os.path.isdir(CACHE)})
                return
            if parsed.path == "/api/bili/resolve":
                qs = urllib.parse.parse_qs(parsed.query)
                url = (qs.get("url") or [""])[0]
                try:
                    bvid = find_bvid(url)
                    if not bvid:
                        self.send_json({"ok": False, "error": "没有识别到 BV 号，请粘贴视频链接或 BV 号"})
                        return
                    log("[req] resolve " + bvid)
                    self.send_json(resolve(bvid))
                except Exception as e:
                    log("[err] resolve %s: %s" % (url[:60], e))
                    self.send_json({"ok": False, "error": str(e) or "解析失败"})
                return
            return super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            log("[err] do_GET %s: %s\n%s" % (self.path[:80], e, traceback.format_exc()))
            try:
                self.send_json({"ok": False, "error": "服务内部错误：%s" % e}, 500)
            except Exception:
                pass

    def log_message(self, fmt, *args):
        # 注意：send_error 时 args[0] 可能是 int，不能拿来做 in 判断，否则抛异常会让连接直接断开
        try:
            if str(getattr(self, "path", "")).startswith("/api/"):
                log("[api] " + str(fmt % args))
        except Exception:
            pass


class Server(socketserver.ThreadingTCPServer):
    # Windows 上 SO_REUSEADDR 允许两个进程同时绑定同一端口（不像 Linux 只允许 TIME_WAIT 复用），
    # 会导致重复双击脚本时悄悄起第二个实例。这里在 Windows 上关掉。
    allow_reuse_address = os.name != "nt"
    daemon_threads = True
    request_queue_size = 32


def open_browser(url):
    """延迟一点再开，确保 socket 已经在 listen"""
    try:
        webbrowser.open(url)
    except Exception:
        pass


def port_in_use_by_us(port):
    """端口被占用时，判断占用者是不是本服务（/api/health 能通就是）"""
    try:
        with urlopen("http://127.0.0.1:%d/api/health" % port, timeout=1.5) as r:
            return b'"ok"' in r.read(120)
    except Exception:
        return False


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    flags = set(a for a in sys.argv[1:] if a.startswith("-"))
    port = int(args[0]) if args else 8777
    url = "http://127.0.0.1:%d/" % port
    auto_open = "--no-open" not in flags

    os.makedirs(CACHE, exist_ok=True)

    # 先看端口上是不是已经有本服务在跑（Windows 的 bind 行为不可靠，不能只靠它报错）
    if port_in_use_by_us(port):
        log("服务已在运行，直接复用：%s" % url)
        if auto_open:
            webbrowser.open(url)
        return

    try:
        httpd = Server(("127.0.0.1", port), Handler)
    except OSError as e:
        if port_in_use_by_us(port):
            log("服务已在运行，直接复用：%s" % url)
            if auto_open:
                webbrowser.open(url)
            return
        log("端口 %d 被别的程序占用（可能是旧的 serve.py，也可能是 8777 被其他软件占了）：%s" % (port, e))
        log("换个端口再试：python tools/serve.py 8899")
        sys.exit(1)

    log("SPECTRA served at %s   （按 Ctrl+C 停止）" % url)
    if auto_open:
        threading.Timer(0.8, open_browser, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
