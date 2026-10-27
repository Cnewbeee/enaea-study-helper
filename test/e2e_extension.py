"""扩展端到端测试：用 Chromium 加载 extension 目录，验证 content script 注入与点击。"""
from pathlib import Path
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
MOCK = ROOT / "test" / "mock.html"
FRAME = ROOT / "test" / "frame.html"
URL = "https://study.enaea.edu.cn/__mock__"
FRAME_URL = "https://study.enaea.edu.cn/__frame__"
PROFILE = Path(tempfile.gettempdir()) / "opencode-enaea-e2e-profile"

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        str(PROFILE),
        headless=False,
        args=[
            f"--disable-extensions-except={EXT}",
            f"--load-extension={EXT}",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    )
    page = context.pages[0] if context.pages else context.new_page()
    page.route(URL, lambda route: route.fulfill(path=str(MOCK), content_type="text/html; charset=utf-8"))
    page.route(FRAME_URL, lambda route: route.fulfill(path=str(FRAME), content_type="text/html; charset=utf-8"))
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)

    # 顶层弹窗
    page.evaluate("showLayui()")
    page.wait_for_timeout(2500)
    data = page.evaluate("Object.assign({}, document.body.dataset)")
    print("top dataset:", data)
    print("PASS top click" if data.get("clicked") == "layui" else "FAIL top click")

    # 原生 confirm
    native = page.evaluate("confirm('您已学习20分钟，是否继续学习？')")
    print("native confirm:", native)
    print("PASS native" if native is True else "FAIL native")

    # 同源 iframe 中的弹窗
    page.evaluate("""(src) => {
        const f = document.createElement('iframe');
        f.src = src;
        f.style.cssText = 'width:600px;height:400px;margin-top:20px';
        document.body.appendChild(f);
    }""", FRAME_URL)
    page.wait_for_timeout(3000)
    frame = next((f for f in page.frames if f.url == FRAME_URL), None)
    if frame is None:
        print("FAIL iframe not found", [f.url for f in page.frames])
    else:
        data = frame.evaluate("Object.assign({}, document.body.dataset)")
        print("iframe dataset:", data)
        print("PASS iframe click" if data.get("clicked") == "frame" else "FAIL iframe click")

    context.close()
