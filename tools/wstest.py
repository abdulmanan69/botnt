import asyncio, base64, json
import urllib.request
import websockets

BASE = "http://127.0.0.1:8011"
AUTH = "Basic " + base64.b64encode(b"admin:test123").decode()


def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={
        "Authorization": AUTH, "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"null")


async def main():
    sessions = call("/api/sessions")
    sid = sessions[0]["id"]
    print("session", sid)
    async with websockets.connect("ws://127.0.0.1:8011/ws",
                                  additional_headers={"Authorization": AUTH}) as ws:
        snap = json.loads(await ws.recv())
        print("snapshot sessions:", len(snap["sessions"]))
        r = call(f"/api/session/{sid}/command", {"type": "mic_stream", "args": {}})
        print("queued", r["type"])
        cam = mic = 0
        end = asyncio.get_event_loop().time() + 8
        while asyncio.get_event_loop().time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 3))
            except asyncio.TimeoutError:
                continue
            if msg.get("type") == "stream":
                if msg["kind"] == "mic":
                    mic += 1
                else:
                    cam += 1
        print("mic frames:", mic, "cam frames:", cam)
        call(f"/api/session/{sid}/command", {"type": "mic_stream", "args": {"sub": "stop"}})

asyncio.run(main())
