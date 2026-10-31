package main

import (
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type scanHit struct {
	IP    string `json:"ip"`
	Ports []int  `json:"ports"`
}

func localSubnet() string {
	ip := primaryIP()
	parts := strings.Split(ip, ".")
	if len(parts) == 4 {
		return strings.Join(parts[:3], ".")
	}
	return "192.168.1"
}

func expandCIDR(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		s = localSubnet()
	}
	if strings.Contains(s, "/") {
		s = strings.Split(s, "/")[0]
	}
	parts := strings.Split(s, ".")
	if len(parts) == 4 {
		s = strings.Join(parts[:3], ".")
	}
	var out []string
	for i := 1; i < 255; i++ {
		out = append(out, fmt.Sprintf("%s.%d", s, i))
	}
	return out
}

func scanNet(subnet, portsStr string) Result {
	if portsStr == "" {
		portsStr = "22,80,443,8443,3306,6379"
	}
	var ports []int
	for _, p := range strings.Split(portsStr, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil {
			ports = append(ports, n)
		}
	}
	hosts := expandCIDR(subnet)

	var mu sync.Mutex
	var hits []scanHit
	var wg sync.WaitGroup
	sem := make(chan struct{}, 64)

	for _, ip := range hosts {
		wg.Add(1)
		sem <- struct{}{}
		go func(ip string) {
			defer wg.Done()
			defer func() { <-sem }()
			var open []int
			for _, p := range ports {
				c, err := net.DialTimeout("tcp",
					fmt.Sprintf("%s:%d", ip, p), 400*time.Millisecond)
				if err == nil {
					c.Close()
					open = append(open, p)
				}
			}
			if len(open) > 0 {
				mu.Lock()
				hits = append(hits, scanHit{ip, open})
				mu.Unlock()
			}
		}(ip)
	}
	wg.Wait()
	sort.Slice(hits, func(i, j int) bool { return hits[i].IP < hits[j].IP })

	b, _ := json.MarshalIndent(hits, "", "  ")
	return Result{OK: true, Out: string(b)}
}