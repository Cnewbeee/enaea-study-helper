"""用 Playwright 在模拟页面上验证弹窗点击逻辑（开发自测用）。

运行：
    python test/run_test.py
"""
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CORE = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
MAIN = (ROOT / "extension" / "main-world.js").read_text(encoding="utf-8")
MOCK = ROOT / "test" / "mock.html"
MOCK_URL = "https://study.enaea.edu.cn/__mock__"

passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {detail}")


def open_page(context):
    page = context.new_page()
    page.route(
        MOCK_URL,
        lambda route: route.fulfill(path=str(MOCK), content_type="text/html; charset=utf-8"),
    )
    page.goto(MOCK_URL, wait_until="domcontentloaded")
    return page


def dataset(page):
    return page.evaluate("Object.assign({}, document.body.dataset)")


def main():
    if not MOCK.exists():
        print("找不到 test/mock.html")
        return 1

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome", headless=True)
        except Exception:
            browser = p.chromium.launch(headless=True)

        context = browser.new_context()
        context.add_init_script(MAIN)
        context.add_init_script(CORE)
        context.route(
            MOCK_URL,
            lambda route: route.fulfill(path=str(MOCK), content_type="text/html; charset=utf-8"),
        )

        # 1. layui 风格弹窗：点击“继续学习”，不点“退出学习”，也不点页面里的同名链接
        page = open_page(context)
        page.evaluate("showLayui()")
        page.wait_for_timeout(2200)
        data = dataset(page)
        check("layui: 点击继续学习", data.get("clicked") == "layui", str(data))
        check("layui: 未点退出学习", "exitClicked" not in data, str(data))
        check("layui: 未点页面普通链接", "decoyClicked" not in data, str(data))
        page.close()

        # 2. 自定义浮层：内容含“20分钟”，按钮为“确定”
        page = open_page(context)
        page.evaluate("showGeneric()")
        page.wait_for_timeout(2200)
        data = dataset(page)
        check("generic: 点击确定", data.get("clicked") == "generic", str(data))
        page.close()

        # 3. 退出确认：不应点击“确定”
        page = open_page(context)
        page.evaluate("showExit()")
        page.wait_for_timeout(2600)
        data = dataset(page)
        check("exit: 未点确定", "exitClicked" not in data, str(data))
        page.close()

        # 4. 交卷确认：不应点击“确定”
        page = open_page(context)
        page.evaluate("showQuiz()")
        page.wait_for_timeout(2600)
        data = dataset(page)
        check("quiz: 未点确定", "quizClicked" not in data, str(data))
        page.close()

        # 5. “继续提交”确认：不应点击
        page = open_page(context)
        page.evaluate("showQuizContinue()")
        page.wait_for_timeout(2600)
        data = dataset(page)
        check("quiz-continue: 未点确定", "quizContinueClicked" not in data, str(data))
        page.close()

        # 6. 隐藏 1 秒后才显示的弹窗
        page = open_page(context)
        page.evaluate("showLayuiLater()")
        page.wait_for_timeout(3000)
        data = dataset(page)
        check("later: 显示后点击继续观看", data.get("clicked") == "later", str(data))
        page.close()

        # 6. 原生 confirm：自动确认
        page = open_page(context)
        page.evaluate("showNative()")
        page.wait_for_timeout(500)
        data = dataset(page)
        check("native confirm: 自动确认", data.get("nativeResult") == "true", str(data))
        page.close()

        # 7. 原生退出 confirm：不应自动确认
        page = open_page(context)
        dialogs = []
        page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
        try:
            page.evaluate("showNativeExit()")
        except Exception:
            pass
        page.wait_for_timeout(600)
        data = dataset(page)
        check("native exit: 保留原生弹窗", len(dialogs) == 1 and data.get("nativeExitResult") == "false", str(data))
        page.close()

        browser.close()

    print(f"\n结果：{passed} 通过，{failed} 失败")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
