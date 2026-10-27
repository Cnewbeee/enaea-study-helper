from pathlib import Path

root = Path(__file__).resolve().parent
core = (root / "extension" / "content.js").read_text(encoding="utf-8")
main = (root / "extension" / "main-world.js").read_text(encoding="utf-8")

header = """// ==UserScript==
// @name         ENAEAA 学习弹窗自动确认
// @namespace    local.enaea.autoconfirm
// @version      1.0.0
// @description  自动点击观看视频时弹出的“继续学习”确认框，并自动恢复播放
// @author       local
// @match        *://*.enaea.edu.cn/*
// @match        *://enaea.edu.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

"""

out = root / "userscript" / "enaea-auto-confirm.user.js"
out.parent.mkdir(exist_ok=True)
out.write_text(header + core + "\n\n" + main, encoding="utf-8")
print(f"created: {out}")
