//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

var (
	kernel32        = syscall.NewLazyDLL("kernel32.dll")
	procFreeConsole = kernel32.NewProc("FreeConsole")
	procGetConsole  = kernel32.NewProc("GetConsoleWindow")
	user32s         = syscall.NewLazyDLL("user32.dll")
	procShowWindow  = user32s.NewProc("ShowWindow")
)

// hideConsole detaches the process from any console it inherited. Combined
// with the -H windowsgui link flag there is no window flash at all.
func hideConsole() {
	procFreeConsole.Call()
	if h, _, _ := procGetConsole.Call(); h != 0 {
		procShowWindow.Call(h, 0) // SW_HIDE
	}
}

const (
	createNoWindow  = 0x08000000
	detachedProcess = 0x00000008
)

// hardenCmd stops a child process from flashing a console window.
func hardenCmd(c *exec.Cmd) {
	if c.SysProcAttr == nil {
		c.SysProcAttr = &syscall.SysProcAttr{}
	}
	c.SysProcAttr.HideWindow = true
	c.SysProcAttr.CreationFlags |= createNoWindow
}

// detachCmd makes a child fully independent of the parent.
func detachCmd(c *exec.Cmd) {
	hardenCmd(c)
	c.SysProcAttr.CreationFlags |= detachedProcess
}

// newCmd is exec.Command with the console window suppressed.
func newCmd(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	hardenCmd(c)
	return c
}
