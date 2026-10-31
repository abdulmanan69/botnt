//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
)

func detach(c *exec.Cmd) {
	if c.SysProcAttr == nil {
		c.SysProcAttr = &syscall.SysProcAttr{}
	}
	c.SysProcAttr.Setsid = true
}

// shellOpen is the Windows code path; unused on unix but must compile.
func shellOpen(path string) error {
	return errors.New("windows only")
}

