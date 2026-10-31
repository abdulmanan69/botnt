import asyncio, base64, struct, uuid
from typing import Callable, Dict, Optional


class SocksHub:
    def __init__(self):
        self.out: Dict[str, asyncio.Queue] = {}
        self.conns: Dict[str, dict] = {}

    def ensure(self, sid: str) -> asyncio.Queue:
        q = self.out.get(sid)
        if q is None:
            q = asyncio.Queue()
            self.out[sid] = q
        return q

    async def push(self, sid: str, frame: dict):
        await self.ensure(sid).put(frame)

    async def poll(self, sid: str, timeout: float = 25.0):
        q = self.ensure(sid)
        try:
            return [await asyncio.wait_for(q.get(), timeout)]
        except asyncio.TimeoutError:
            return []

    async def bot_events(self, sid: str, frames: list):
        for f in frames:
            cid = f.get("cid")
            c = self.conns.get(cid)
            if not c:
                continue
            t = f.get("t")
            if t == "connected":
                if not c["ready"].done():
                    c["ready"].set_result(bool(f.get("ok")))
            elif t == "data":
                await c["to_browser"].put(base64.b64decode(f.get("b64", "")))
            elif t == "close":
                await c["to_browser"].put(None)

    def drop_session(self, sid: str):
        self.out.pop(sid, None)


HUB = SocksHub()


async def _pump_browser_to_bot(sid, cid, reader, writer):
    try:
        while True:
            data = await reader.read(16384)
            if not data:
                break
            await HUB.push(sid, {"t": "data", "cid": cid,
                                 "b64": base64.b64encode(data).decode()})
    except Exception:
        pass
    finally:
        await HUB.push(sid, {"t": "close", "cid": cid})
        try:
            writer.close()
        except Exception:
            pass


async def _pump_bot_to_browser(cid, writer):
    q = HUB.conns[cid]["to_browser"]
    try:
        while True:
            data = await q.get()
            if data is None:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def _handle(reader, writer, pick_bot):
    cid = None
    try:
        await reader.readexactly(1)                     # ver
        nmethods = (await reader.readexactly(1))[0]
        await reader.readexactly(nmethods)
        writer.write(b"\x05\x00")                       # no auth
        await writer.drain()

        _v, _cmd, _rsv, atyp = await reader.readexactly(4)
        if atyp == 1:
            host = ".".join(str(b) for b in await reader.readexactly(4))
        elif atyp == 3:
            ln = (await reader.readexactly(1))[0]
            host = (await reader.readexactly(ln)).decode()
        elif atyp == 4:
            raw = await reader.readexactly(16)
            host = ":".join(f"{raw[i]:02x}{raw[i+1]:02x}" for i in range(0, 16, 2))
        else:
            return
        port = struct.unpack(">H", await reader.readexactly(2))[0]

        sid = pick_bot()
        if not sid:
            writer.write(b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            return

        cid = uuid.uuid4().hex
        ready = asyncio.get_running_loop().create_future()
        HUB.conns[cid] = {"ready": ready, "to_browser": asyncio.Queue()}
        await HUB.push(sid, {"t": "connect", "cid": cid, "host": host, "port": port})

        ok = await asyncio.wait_for(ready, timeout=15)
        if not ok:
            writer.write(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            return
        writer.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        await writer.drain()

        await asyncio.gather(
            _pump_browser_to_bot(sid, cid, reader, writer),
            _pump_bot_to_browser(cid, writer),
        )
    except Exception:
        pass
    finally:
        if cid:
            HUB.conns.pop(cid, None)


async def start_socks(host: str, port: int, pick_bot: Callable[[], Optional[str]]):
    return await asyncio.start_server(
        lambda r, w: _handle(r, w, pick_bot), host, port)