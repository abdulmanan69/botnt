"""Headless UI smoke test over the DevTools protocol: screenshot + JS errors."""

import asyncio, base64, json, sys, urllib.request

import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8014/?token=test123"
OUT = sys.argv[2] if len(sys.argv) > 2 else "ui.png"

errors = []


def targets():
    with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5) as r:
        return json.loads(r.read())


async def main():
    ts = [t for t in targets() if t["type"] == "page"]
    ws_url = ts[0]["webSocketDebuggerUrl"]
    async with websockets.connect(ws_url, max_size=40 * 1024 * 1024) as ws:
        seq = 0

        async def call(method, params=None):
            nonlocal seq
            seq += 1
            await ws.send(json.dumps({"id": seq, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == seq:
                    return msg.get("result", {})
                ev = msg.get("method")
                if ev == "Runtime.exceptionThrown":
                    errors.append(msg["params"]["exceptionDetails"].get("text", "exception"))
                if ev == "Log.entryAdded" and msg["params"]["entry"]["level"] == "error":
                    errors.append(msg["params"]["entry"]["text"])

        await call("Runtime.enable")
        await call("Log.enable")
        await call("Page.enable")
        await call("Emulation.setDeviceMetricsOverride",
                   {"width": 1500, "height": 950, "deviceScaleFactor": 1, "mobile": False})
        await call("Page.navigate", {"url": URL})
        await asyncio.sleep(9)

        dom = await call("Runtime.evaluate", {
            "expression": "JSON.stringify({hosts:document.querySelectorAll('#sessions li').length,"
                          "conn:document.getElementById('status').textContent,"
                          "ws:typeof ws!=='undefined'&&ws?ws.readyState:'none',"
                          "canvas:!!document.getElementById('micwave'),"
                          "cards:document.querySelectorAll('.card').length,"
                          "buildTab:!!document.getElementById('b_build')})",
            "returnByValue": True})
        print("DOM:", dom.get("result", {}).get("value"))

        shot = await call("Page.captureScreenshot", {"format": "png"})
        with open(OUT, "wb") as fh:
            fh.write(base64.b64decode(shot["data"]))
        print("saved", OUT)
        print("errors:", errors or "none")

asyncio.run(main())
