#!/usr/bin/env python3
"""ENAEAA 学习视频弹窗自动确认（Playwright 版）

特点：
  * 复用 extension/content.js 的弹窗点击逻辑（含 iframe）
  * 能自动确认浏览器原生 confirm 弹窗
  * 使用独立 Chrome 配置目录，首次运行登录一次即可

安装：
    pip install -r python/requirements.txt

运行（保持本目录结构）：
    python python/enaea_auto_confirm.py

首次运行会打开 Chrome，请在浏览器里手动登录。登录后保持终端和浏览器运行。
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, Error as PlaywrightError
except ImportError:
    print("未安装 playwright。请先运行：pip install -r python/requirements.txt")
    sys.exit(1)

DEFAULT_URL = os.environ.get(
    "ENAEA_COURSE_URL",
    "https://study.enaea.edu.cn/viewerforccvideo.do?courseId=YOUR_COURSE_ID&circleId=YOUR_CIRCLE_ID",
)

BLOCK_WORDS = ["退出学习", "退出课程", "离开学习", "离开课程", "结束学习",
               "提交", "交卷", "答题", "删除", "确认退出", "确定退出"]
ALLOW_WORDS = ["继续学习", "继续观看", "继续播放", "是否继续", "分钟", "观看", "学习", "播放"]


def load_core() -> str:
    here = Path(__file__).resolve().parent
    candidates = [
        here.parent / "extension" / "content.js",
        Path.cwd() / "extension" / "content.js",
    ]
    for path in candidates:
        if path.exists():
            return path.read_text(encoding="utf-8")
    print("找不到 extension/content.js。")
    print("请把整个 enaea-auto-confirm 文件夹放在一起运行，或从项目根目录运行本脚本。")
    sys.exit(1)


def handle_dialog(dialog) -> None:
    message = dialog.message or ""
    is_safe = (
        dialog.type in ("alert", "confirm")
        and any(w in message for w in ALLOW_WORDS)
        and not any(w in message for w in BLOCK_WORDS)
    )
    if is_safe:
        print(f"[原生弹窗] 自动确认：{message!r}")
        try:
            dialog.accept()
            return
        except PlaywrightError as exc:
            print(f"[原生弹窗] 确认失败：{exc}")
    else:
        print(f"[原生弹窗] 未自动确认（{dialog.type}）：{message!r}")
    try:
        dialog.dismiss()
    except PlaywrightError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="ENAEAA 学习视频弹窗自动确认")
    parser.add_argument("--url", default=DEFAULT_URL, help="课程视频地址")
    parser.add_argument(
        "--profile",
        default=str(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "enaea-auto-profile"),
        help="Chrome 用户数据目录（用于保存登录状态）",
    )
    parser.add_argument("--headless", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if not args.url or "YOUR_COURSE_ID" in args.url or "YOUR_CIRCLE_ID" in args.url:
        parser.error(
            "请用 --url 传入你的课程地址，例如："
            "python python/enaea_auto_confirm.py --url \"https://study.enaea.edu.cn/viewerforccvideo.do?courseId=123456&circleId=789012\""
        )

    core = load_core()
    Path(args.profile).mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        launch_options = dict(
            user_data_dir=args.profile,
            headless=args.headless,
            no_viewport=not args.headless,
            args=["--start-maximized", "--no-first-run", "--no-default-browser-check"],
        )
        try:
            context = p.chromium.launch_persistent_context(channel="chrome", **launch_options)
        except Exception as exc:
            print(f"启动本机 Chrome 失败（{exc}），改用 Playwright 自带 Chromium。")
            try:
                context = p.chromium.launch_persistent_context(**launch_options)
            except Exception as exc2:
                print(f"启动浏览器失败：{exc2}")
                print("如果使用自带 Chromium，请先运行：playwright install chromium")
                return 1

        # 在所有页面、所有 iframe 中注入弹窗点击脚本
        context.add_init_script(core)

        page = context.pages[0] if context.pages else context.new_page()
        for extra in list(context.pages[1:]):
            try:
                extra.close()
            except PlaywrightError:
                pass

        page.on("dialog", handle_dialog)
        page.on(
            "console",
            lambda msg: print(f"[页面] {msg.text}")
            if "[enaea-auto]" in (msg.text or "")
            else None,
        )

        print("正在打开课程页面……")
        try:
            page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        except PlaywrightError as exc:
            print(f"打开页面失败：{exc}")

        print()
        print("=" * 60)
        print("脚本已启动。")
        print("1. 如果页面要求登录，请在浏览器中手动登录。")
        print("2. 登录后打开课程视频页面，保持终端和浏览器运行。")
        print("3. 弹窗出现后会自动点击“继续学习/确定”，并恢复播放。")
        print("4. 按 Ctrl+C 停止（浏览器会关闭）。")
        print("=" * 60)

        ticks = 0
        try:
            while True:
                page.wait_for_timeout(1000)
                if page.is_closed():
                    print("页面已关闭，脚本退出。")
                    break
                ticks += 1
                # 兜底：每 10 秒向所有 iframe 补注入一次
                if ticks % 10 == 0:
                    for frame in list(page.frames):
                        try:
                            frame.evaluate(core)
                        except PlaywrightError:
                            pass
        except KeyboardInterrupt:
            print("\n已停止。")
        except PlaywrightError as exc:
            print(f"\n浏览器连接已断开：{exc}")
        finally:
            try:
                context.close()
            except PlaywrightError:
                pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
