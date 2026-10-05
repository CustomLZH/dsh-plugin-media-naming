# -*- coding: utf-8 -*-
"""plan_operations 的动作判定回归测试。

关键规则：
- **作品目录改名**（父路径一致、仅最后一段不同）→ 文件**原地改名**，不移动、不新建目录；
- **补 Season 子目录**（层级变了）或**跨库移动** → 才需要移动并创建目录。

早期版本把两者混为一谈（`needsMove = current_dirs != proposed_dirs`），
于是「改个目录名」被做成了「新建目录 + 搬运 26 个文件」，还差点撞名。

运行：py -u test/operation-plan-test.py
"""
from __future__ import annotations

import platform
import sys
from pathlib import Path

platform.system = lambda: "Windows"                      # noqa: E731
platform.win32_ver = lambda *a, **k: ("", "", "", "")    # noqa: E731
platform.uname = lambda: ("Windows", "", "", "", "")     # noqa: E731

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from apply_support import plan_operations  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

CHECKS: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))


def only(current_path: str, proposed_path: str) -> dict:
    operations = plan_operations([{
        "status": "CHANGED",
        "currentPath": current_path,
        "proposedPath": proposed_path,
    }])
    return operations[0] if operations else {}


# 1) 作品目录改名：文件原地改名，不动位置
renamed = only(
    "影视资源/电视剧/【发布页 www.example.com】示例剧名[全26集][国语音轨+简繁英字幕]"
    ".Sample.Show.S01.2026.2160p.IQ.WEB-DL.H265.DDP5.1-Group"
    "/示例剧名.Sample.Show.S01E01.2026.2160p.IQ.WEB-DL.H265.DDP5.1-Group.mkv",
    "影视资源/电视剧/示例剧名 (2026)/示例剧名 S01E01.mkv",
)
check("作品目录改名：不移动文件", renamed.get("needsMove") is False, str(renamed.get("needsMove")))
check("作品目录改名：不新建目录", renamed.get("needsMkdir") is False, str(renamed.get("needsMkdir")))
check("作品目录改名：仍然改文件名", renamed.get("needsRename") is True)
check("作品目录改名：标记 workdirRenamed", renamed.get("workdirRenamed") is True)

# 2) 补 Season 子目录：层级变了，确实需要移动
season = only(
    "影视资源/动漫/示例动漫 (2018)/[Group][示例动漫][001][1080P].mp4",
    "影视资源/动漫/示例动漫 (2018)/Season 01/示例动漫 S01E01.mp4",
)
check("补 Season 子目录：需要移动", season.get("needsMove") is True, str(season.get("needsMove")))
check("补 Season 子目录：需要建目录", season.get("needsMkdir") is True)
check("补 Season 子目录：不算目录改名", season.get("workdirRenamed") is False)

# 3) 仅改文件名：既不移动也不建目录
plain = only(
    "影视资源/电影/示例电影 (2024)/示例电影.2024.2160p.mkv",
    "影视资源/电影/示例电影 (2024)/示例电影 (2024).mkv",
)
check("仅改文件名：不移动", plain.get("needsMove") is False)
check("仅改文件名：不建目录", plain.get("needsMkdir") is False)
check("仅改文件名：改名", plain.get("needsRename") is True)

# 4) 跨库移动（父路径不同）→ 需要移动
crossed = only(
    "影视资源/电视剧/某剧 (2020)/某剧 S01E01.mkv",
    "影视资源/电影/某剧 (2020)/某剧 (2020).mkv",
)
check("跨库移动：需要移动", crossed.get("needsMove") is True, str(crossed.get("needsMove")))

failed = 0
for name, ok, detail in CHECKS:
    if not ok:
        failed += 1
    print(f"[{'OK' if ok else 'FAIL'}] {name}{'' if ok else f'（{detail}）'}")
print("=" * 60)
print(f"checks passed={len(CHECKS) - failed} failed={failed}")
sys.exit(0 if failed == 0 else 1)
