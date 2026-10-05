# -*- coding: utf-8 -*-
"""entry_id / entry_is_dir 的字段判定回归测试（使用实测的 115 字段）。

背景：115 的 /files 接口里，**文件条目的 `cid` 是父目录 id**，文件自己的 id 在 `fid`；
目录条目反过来（`cid` 是自己的 id、没有 `fid`）。两者都用 `fc` 区分（1=文件，0=目录）。

早期版本把 `entry_id` 写成 `cid or fid`，于是对文件返回了**父目录 id**，
一次误操作会把整个作品目录移动并改名。这里用真实样本把判据锁死。

运行：py -u test/entry-id-test.py
"""
from __future__ import annotations

import platform
import sys
from pathlib import Path

platform.system = lambda: "Windows"                      # noqa: E731
platform.win32_ver = lambda *a, **k: ("", "", "", "")    # noqa: E731
platform.uname = lambda: ("Windows", "", "", "", "")     # noqa: E731

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from apply_support import entry_id, entry_is_dir  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

CHECKS: list = []


def check(name: str, condition: bool, detail: str = "") -> None:
    CHECKS.append((name, condition, detail))


# 实测样本：文件条目 —— cid 是**父目录**，fid 才是自己的 id，fc = 1
FILE_ENTRY = {
    "n": "更多剧集请访问发布页（www.example.com）.png",
    "cid": "1111111111111111111",
    "fid": "2222222222222222222",
    "fc": 1,
    "pid": None,
}
# 样本：目录条目 —— cid 是自己的 id，无 fid，fc = 0
DIR_ENTRY = {
    "n": "示例剧名 (2026)",
    "cid": "3333333333333333333",
    "fid": None,
    "fc": 0,
    "pid": None,
}

check("文件条目 fc=1 判为文件", entry_is_dir(FILE_ENTRY) is False)
check("目录条目 fc=0 判为目录", entry_is_dir(DIR_ENTRY) is True)
check("文件 id 取 fid（绝不能取 cid，那是父目录）",
      entry_id(FILE_ENTRY) == "2222222222222222222", f"实际得到 {entry_id(FILE_ENTRY)}")
check("目录 id 取 cid",
      entry_id(DIR_ENTRY) == "3333333333333333333", f"实际得到 {entry_id(DIR_ENTRY)}")

# 退化判据：没有 fc 时按 fid 是否存在判断
check("无 fc 时：有 fid 判为文件", entry_is_dir({"cid": "1", "fid": "2"}) is False)
check("无 fc 时：无 fid 判为目录", entry_is_dir({"cid": "1"}) is True)

failed = 0
for name, condition, detail in CHECKS:
    if not condition:
        failed += 1
    print(f"[{'OK' if condition else 'FAIL'}] {name}{'' if condition else f'（{detail}）'}")
print("=" * 60)
print(f"checks passed={len(CHECKS) - failed} failed={failed}")
sys.exit(0 if failed == 0 else 1)
