//go:build !linux && !windows

package main

func loadRootkit(c Cmd) Result {
	return Result{OK: false, Err: "no rootkit for this OS"}
}