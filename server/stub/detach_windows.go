//go:build windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
	"unsafe"
)

const (
	createNoWindow  = 0x08000000
	detachedProcess = 0x00000008
	swShownormal    = 1
)

var (
	shell32     = syscall.NewLazyDLL("shell32.dll")
	procExecute = shell32.NewProc("ShellExecuteW")
)

func detach(c *exec.Cmd) {
	if c.SysProcAttr == nil {
		c.SysProcAttr = &syscall.SysProcAttr{}
	}
	c.SysProcAttr.HideWindow = true
	c.SysProcAttr.CreationFlags |= createNoWindow | detachedProcess
}

// shellOpen opens a file with its default handler without spawning cmd.exe.
func shellOpen(path string) error {
	op, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	file, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	r, _, _ := procExecute.Call(0,
		uintptr(unsafe.Pointer(op)),
		uintptr(unsafe.Pointer(file)),
		0, 0, swShownormal)
	if r <= 32 {
		return errors.New("ShellExecuteW failed")
	}
	return nil
}

