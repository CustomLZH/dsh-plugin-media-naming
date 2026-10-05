# -*- coding: utf-8 -*-
"""115 扫码登录（media-naming 提供的**方法**，由使用者自己运行）。

扫码得到的是完整的账号 cookie，与你手工复制的那串权限完全相同；
有效期到了就再扫一次即可。

用法：
    py -u login_115.py                  # 终端显示二维码，扫码后写入凭据并更新配置
    py -u login_115.py --png qr.png     # 生成二维码图片并等待扫码（适合由 Agent 展示图片给你扫）
    py -u login_115.py --self-check     # 只检查环境（是否装了依赖、配置目录能否写入），不联网
    py -u login_115.py --app qandroid   # 指定扫码后绑定的设备类型
    py -u login_115.py --cookies-out <路径>   # 指定凭据写入位置
    py -u login_115.py --no-config      # 只写凭据文件，不改配置

安全提示：脚本只写入**本机配置文件与凭据文件**，不会上传到任何地方；
终端里的二维码仅用于本次登录，过期即失效。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import sys
import time
from pathlib import Path

# 必须在导入任何第三方网络库之前执行：本机 platform.system() 会经 COM 查询 WMI
# 且永不返回，导致 urllib3 / 网盘客户端在「导入阶段」就卡死。
platform.system = lambda: "Windows"                      # noqa: E731
platform.win32_ver = lambda *a, **k: ("", "", "", "")    # noqa: E731
platform.uname = lambda: ("Windows", "", "", "", "")     # noqa: E731

DEFAULT_APP = "qandroid"


def dsh_home() -> Path:
    home = os.environ.get("DSH_HOME")
    return Path(home) if home else Path.home() / ".dsh"


def config_dir() -> Path:
    return dsh_home() / "media-naming"


def config_path() -> Path:
    return config_dir() / "config.json"


def default_cookies_path() -> Path:
    return config_dir() / "cookies.txt"


def _cookie_string(value) -> str:
    """把接口返回的凭据字段统一成 `k=v; k=v` 形式（兼容字符串 / 字典 / 列表）。"""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        pairs = [f"{key}={val}" for key, val in value.items() if val is not None]
        return "; ".join(pairs)
    if isinstance(value, (list, tuple)):
        pairs = []
        for item in value:
            if isinstance(item, dict):
                name = item.get("name") or item.get("key")
                val = item.get("value")
                if name and val is not None:
                    pairs.append(f"{name}={val}")
        return "; ".join(pairs)
    return ""


def _extract_cookies(result) -> str:
    """兼容多种返回形态，取出 cookie 字符串。

    115 的扫码结果可能把凭据放在 `data.cookie`、直接摊在 `data` 里，
    或顶层就是凭据字段；这里逐一尝试，避免"手机确认了却没拿到凭据"。
    """
    if isinstance(result, str):
        return result.strip()

    key_names = ("UID", "CID", "SEID", "KID")
    if not isinstance(result, dict):
        for attr in ("cookies_str", "cookies"):
            text = _cookie_string(getattr(result, attr, None))
            if text:
                return text
        return ""

    data = result.get("data")
    if isinstance(data, dict):
        for key in ("cookie", "cookies", "cookie_string"):
            text = _cookie_string(data.get(key))
            if text:
                return text
        if any(name in data for name in key_names):
            return _cookie_string(data)
    for key in ("cookie", "cookies", "cookie_string"):
        text = _cookie_string(result.get(key))
        if text:
            return text
    if any(name in result for name in key_names):
        return _cookie_string(result)
    return ""


def _result_shape(result) -> dict:
    """只回报返回结构的键名（不含任何凭据值），便于排查"没取到凭据"。"""
    if not isinstance(result, dict):
        return {"type": type(result).__name__}
    data = result.get("data")
    return {
        "keys": sorted(str(key) for key in result.keys())[:20],
        "dataKeys": sorted(str(key) for key in data.keys())[:20] if isinstance(data, dict) else type(data).__name__,
    }


def write_cookies(cookies: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(cookies, encoding="utf-8")


def update_config(cookies_path: Path) -> None:
    """把凭据路径写进插件配置（保留其它已有字段）。"""
    path = config_path()
    data = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"⚠️ 现有配置不是合法 JSON，将重建：{path}")
            data = {}
    data["cookiesPath"] = str(cookies_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_self_check() -> int:
    print("环境自检（不联网）：")
    failed = 0

    version = ""
    try:
        import p115client  # noqa: F401
        version = getattr(p115client, "__version__", "")
        print(f"  ✓ p115client 可导入 {version}")
    except Exception as error:  # noqa: BLE001
        failed += 1
        print(f"  ✗ p115client 不可导入：{error}")
        print("    安装：py -m pip install --user p115client")

    has_qrcode = importlib.util.find_spec("qrcode") is not None
    print(f"  {'✓' if has_qrcode else '✗'} qrcode 库（终端显示二维码需要）"
          + ("" if has_qrcode else "；安装：py -m pip install --user qrcode"))
    if not has_qrcode:
        failed += 1

    directory = config_dir()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        probe = directory / ".write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        print(f"  ✓ 配置目录可写：{directory}")
    except Exception as error:  # noqa: BLE001
        failed += 1
        print(f"  ✗ 配置目录不可写：{directory}（{error}）")

    print(f"  凭据将写入：{default_cookies_path()}")
    print(f"  配置将更新：{config_path()}")
    return 0 if failed == 0 else 1


def write_qr_png(text: str, target: Path, scale: int = 8, border: int = 4) -> None:
    """把文本写成二维码 PNG。

    只依赖 `qrcode` 的矩阵与标准库 `zlib` / `struct`，**不需要 Pillow**——
    本机的 Python 装了 qrcode 却没有 PIL，用这个实现可以省掉一次额外安装。
    """
    import struct
    import zlib

    import qrcode

    qr = qrcode.QRCode(border=0, box_size=1)
    qr.add_data(text)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    size = len(matrix)
    dimension = (size + border * 2) * scale

    raw = bytearray()
    for y in range(dimension):
        raw.append(0)  # PNG 行过滤类型：无
        my = y // scale - border
        for x in range(dimension):
            mx = x // scale - border
            dark = 0 <= my < size and 0 <= mx < size and matrix[my][mx]
            raw.append(0 if dark else 255)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", dimension, dimension, 8, 0, 0, 0, 0)
    target.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def run_png_mode(args) -> int:
    """生成二维码图片并等待扫码，输出 JSON 进度（适合由 Agent 展示图片给使用者扫）。

    分两段输出：
      1) {"stage": "waiting", "pngPath": …}  —— 展示这张图给使用者扫
      2) {"stage": "done" | "timeout" | "aborted" | "error", …}
    """
    try:
        from p115client import P115Client
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "stage": "error", "message": f"无法导入 p115client：{error}"}, ensure_ascii=False))
        return 1

    try:
        token_response = P115Client.login_qrcode_token()
        qrcode_token = (token_response or {}).get("data") or {}
        login_uid = qrcode_token.get("uid")
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "stage": "error", "message": f"获取二维码失败：{error}"}, ensure_ascii=False))
        return 1
    if not login_uid:
        print(json.dumps({"ok": False, "stage": "error", "message": f"获取二维码失败：{token_response}"}, ensure_ascii=False))
        return 1

    qrcode_url = qrcode_token.get("qrcode") or f"https://115.com/scan/dg-{login_uid}"
    png_path = Path(args.png)
    try:
        png_path.parent.mkdir(parents=True, exist_ok=True)
        write_qr_png(qrcode_url, png_path)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "stage": "error", "message": f"生成二维码图片失败：{error}"}, ensure_ascii=False))
        return 1

    print(json.dumps({
        "ok": True,
        "stage": "waiting",
        "pngPath": str(png_path),
        "uid": login_uid,
        "waitSeconds": args.wait,
        "hint": "请用 115 手机 App 扫这张图，并在手机上确认登录",
    }, ensure_ascii=False), flush=True)

    deadline = time.time() + max(10, int(args.wait))
    last_status = None
    completed = False
    while time.time() < deadline:
        try:
            status_response = P115Client.login_qrcode_scan_status(qrcode_token)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"ok": False, "stage": "error", "message": f"查询扫码状态失败：{error}"}, ensure_ascii=False), flush=True)
            return 1
        status = ((status_response or {}).get("data") or {}).get("status")
        if status != last_status:
            last_status = status
            if status == 1:
                print(json.dumps({"ok": True, "stage": "scanned", "message": "已扫码，请在手机上点确认"}, ensure_ascii=False), flush=True)
            elif status in (-1, -2):
                message = "二维码已过期，请重新生成" if status == -1 else "扫码已被取消"
                print(json.dumps({"ok": False, "stage": "aborted", "message": message}, ensure_ascii=False), flush=True)
                return 1
        if status == 2:
            completed = True
            break
        time.sleep(2)

    if not completed:
        print(json.dumps({"ok": False, "stage": "timeout", "message": f"等待 {args.wait} 秒仍未完成扫码，可重新运行本命令"}, ensure_ascii=False), flush=True)
        return 1

    try:
        # 注意：该接口第一个参数是「扫码 uid 字符串」，不是 token 字典
        result = P115Client.login_qrcode_scan_result(login_uid, app=args.app)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "stage": "error", "message": f"换取凭据失败：{error}"}, ensure_ascii=False), flush=True)
        return 1

    cookies = _extract_cookies(result)
    if not cookies:
        print(json.dumps({
            "ok": False,
            "stage": "error",
            "message": "手机已确认，但没有取到凭据",
            "shape": _result_shape(result),
        }, ensure_ascii=False), flush=True)
        return 1

    target = Path(args.cookies_out) if args.cookies_out else default_cookies_path()
    write_cookies(cookies, target)
    if not args.no_config:
        update_config(target)
    print(json.dumps({
        "ok": True,
        "stage": "done",
        "cookiesPath": str(target),
        "configPath": str(config_path()) if not args.no_config else "",
    }, ensure_ascii=False), flush=True)
    return 0


def main(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(description="115 扫码登录，并把凭据写入本机配置")
    parser.add_argument("--self-check", action="store_true", help="只检查环境，不联网")
    parser.add_argument("--app", default=DEFAULT_APP, help=f"扫码后绑定的设备类型，默认 {DEFAULT_APP}")
    parser.add_argument("--cookies-out", default="", help="凭据写入位置，默认写入插件配置目录")
    parser.add_argument("--no-config", action="store_true", help="只写凭据文件，不更新配置")
    parser.add_argument("--png", default="", help="生成二维码图片到该路径并等待扫码（适合由 Agent 展示图片给你扫）")
    parser.add_argument("--wait", type=int, default=150, help="--png 模式下等待扫码的秒数，默认 150")
    args = parser.parse_args(argv[1:])

    if args.self_check:
        return run_self_check()
    if args.png:
        return run_png_mode(args)

    try:
        from p115client import P115Client
    except Exception as error:  # noqa: BLE001
        print(f"无法导入 p115client：{error}")
        print("安装：py -m pip install --user p115client")
        return 1

    print("即将在终端显示二维码：请用 115 手机 App 扫码，并在手机上确认登录。")
    print("（二维码过期或被取消会直接报错，重新运行本脚本即可）")

    try:
        result = P115Client.login_with_qrcode(app=args.app, console_qrcode=True)
    except KeyboardInterrupt:
        print("\n已取消。")
        return 130
    except Exception as error:  # noqa: BLE001
        print(f"登录失败：{error}")
        return 1

    cookies = _extract_cookies(result)
    if not cookies:
        print("登录流程结束，但没有取到 cookie；请重试，或用 --app 换一个设备类型。")
        return 1

    target = Path(args.cookies_out) if args.cookies_out else default_cookies_path()
    write_cookies(cookies, target)
    print(f"✅ 凭据已写入：{target}")

    if not args.no_config:
        update_config(target)
        print(f"✅ 已更新配置：{config_path()}")

    print("现在回到 DSH 继续即可：凭据已就绪，可以直接说明要处理哪个目录。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
