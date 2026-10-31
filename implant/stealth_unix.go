//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func hideConsole() {}

func hardenCmd(c *exec.Cmd) {}

func detachCmd(c *exec.Cmd) {
	if c.SysProcAttr == nil {
		c.SysProcAttr = &syscall.SysProcAttr{}
	}
	c.SysProcAttr.Setsid = true
}

// newCmd is exec.Command with the console window suppressed (no-op off Windows).
func newCmd(name string, args ...string) *exec.Cmd {
	return exec.Command(name, args...)
}
