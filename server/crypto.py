import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD = b"phantom-v2"

class Box:
    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("PSK must be 32 bytes")
        self._aes = AESGCM(key)

    def seal(self, plaintext: bytes) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._aes.encrypt(nonce, plaintext, AAD)

    def open(self, blob: bytes) -> bytes:
        return self._aes.decrypt(blob[:12], blob[12:], AAD)