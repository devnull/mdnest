package handlers

import (
	"errors"
	"testing"

	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// A personal namespace with no active backup must stay local-only. If this
// returned ok=false with no error instead, the git writer would fall back to
// GIT_REMOTE_URL and push someone's private notes into the shared repository
// group, which cannot be taken back.
func TestWorkspaceRemoteResolver(t *testing.T) {
	rows := map[string]*store.WorkspaceRemote{
		"team": {Transport: "https", RemoteURL: "https://git.example/team.git", Branch: "main"},
	}
	r := WorkspaceRemoteResolver(func(ns string) (*store.WorkspaceRemote, error) { return rows[ns], nil })

	if _, ok, err := r.ResolveRemote("jane@example.com"); ok || !errors.Is(err, storage.ErrLocalOnly) {
		t.Fatalf("personal namespace without a backup: ok=%v err=%v, want ok=false and ErrLocalOnly", ok, err)
	}
	if _, ok, err := r.ResolveRemote("notes"); ok || err != nil {
		t.Fatalf("team namespace without a row: ok=%v err=%v, want the env default (ok=false, nil)", ok, err)
	}
	spec, ok, err := r.ResolveRemote("team")
	if !ok || err != nil || spec.RemoteURL != "https://git.example/team.git" {
		t.Fatalf("team namespace with a row: spec=%+v ok=%v err=%v", spec, ok, err)
	}

	boom := errors.New("db down")
	failing := WorkspaceRemoteResolver(func(string) (*store.WorkspaceRemote, error) { return nil, boom })
	if _, _, err := failing.ResolveRemote("jane@example.com"); !errors.Is(err, boom) {
		t.Fatalf("lookup error must be returned as is, got %v", err)
	}
}
