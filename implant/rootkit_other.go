//go:build !linux && !windows

package main

func loadRootkit(c Cmd) Result {
	if str(c.Args["sub"]) == "status" {
		return Result{OK: true, Out: "no rootkit for this OS"}
	}
	return Result{OK: false, Err: "no rootkit for this OS"}
}