package docfetch_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lima/worker/internal/docfetch"
)

// bypassSSRF replaces LookupHostFn with a stub returning a safe public IP so
// that tests can reach httptest servers on 127.0.0.1 without triggering the
// SSRF block. The returned function restores the original and must be deferred.
func bypassSSRF() func() {
	orig := docfetch.LookupHostFn
	docfetch.LookupHostFn = func(_ string) ([]string, error) {
		return []string{"93.184.216.34"}, nil // a safe public IP
	}
	return func() { docfetch.LookupHostFn = orig }
}

// TestHappyPath: root page with 2 same-origin links → 3 pages, all non-empty.
func TestHappyPath(t *testing.T) {
	defer bypassSSRF()()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		base := "http://" + r.Host
		fmt.Fprintf(w, `<html><body><a href="%s/page1">1</a><a href="%s/page2">2</a></body></html>`, base, base)
	})
	mux.HandleFunc("/page1", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "page1 content")
	})
	mux.HandleFunc("/page2", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "page2 content")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, err := docfetch.Fetch(context.Background(), srv.URL+"/", 1, 10*1024*1024)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Pages) != 3 {
		t.Errorf("expected 3 pages, got %d", len(result.Pages))
	}
	for i, p := range result.Pages {
		if p.Body == "" {
			t.Errorf("page %d has empty body", i)
		}
	}
}

// TestMaxBytesCap: root=60 KB, two links each 30 KB, maxBytes=80*1024 →
// only root + first link are returned (adding second would push total past cap).
func TestMaxBytesCap(t *testing.T) {
	defer bypassSSRF()()

	const (
		rootSize = 60 * 1024
		linkSize = 30 * 1024
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		base := "http://" + r.Host
		links := fmt.Sprintf(`<a href="%s/link1">1</a><a href="%s/link2">2</a>`, base, base)
		padding := strings.Repeat("x", rootSize-len(links))
		fmt.Fprint(w, links+padding)
	})
	mux.HandleFunc("/link1", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, strings.Repeat("a", linkSize))
	})
	mux.HandleFunc("/link2", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, strings.Repeat("b", linkSize))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, err := docfetch.Fetch(context.Background(), srv.URL+"/", 1, 80*1024)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Pages) != 2 {
		t.Errorf("expected 2 pages (root + first link), got %d", len(result.Pages))
	}
}

// TestRootReturns500: a 500 root response must produce a non-nil error.
func TestRootReturns500(t *testing.T) {
	defer bypassSSRF()()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := docfetch.Fetch(context.Background(), srv.URL+"/", 1, 1024*1024)
	if err == nil {
		t.Error("expected non-nil error for 500 root response")
	}
}

// TestLinkedPageReturns404: a 404 on a linked page is silently skipped; root is present.
func TestLinkedPageReturns404(t *testing.T) {
	defer bypassSSRF()()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		base := "http://" + r.Host
		fmt.Fprintf(w, `<a href="%s/missing">link</a>`, base)
	})
	mux.HandleFunc("/missing", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, err := docfetch.Fetch(context.Background(), srv.URL+"/", 1, 1024*1024)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Pages) == 0 {
		t.Fatal("expected at least the root page")
	}
	if result.Pages[0].URL != srv.URL+"/" {
		t.Errorf("first page URL = %q, want %q", result.Pages[0].URL, srv.URL+"/")
	}
}

// TestSSRFBlockedHost: a URL whose host resolves to 127.0.0.1 must return ErrBlockedHost.
func TestSSRFBlockedHost(t *testing.T) {
	// Do NOT bypass SSRF — the real LookupHostFn must block 127.0.0.1.
	_, err := docfetch.Fetch(context.Background(), "http://127.0.0.1:65432/test", 1, 1024*1024)
	if !errors.Is(err, docfetch.ErrBlockedHost) {
		t.Errorf("expected ErrBlockedHost, got %v", err)
	}
}

// TestUnsupportedScheme: an ftp:// URL must return ErrUnsupportedScheme.
func TestUnsupportedScheme(t *testing.T) {
	_, err := docfetch.Fetch(context.Background(), "ftp://example.com", 1, 1024*1024)
	if !errors.Is(err, docfetch.ErrUnsupportedScheme) {
		t.Errorf("expected ErrUnsupportedScheme, got %v", err)
	}
}

// TestCrossOriginLinksIgnored: only same-origin links are followed; cross-origin are skipped.
func TestCrossOriginLinksIgnored(t *testing.T) {
	defer bypassSSRF()()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		base := "http://" + r.Host
		fmt.Fprintf(w,
			`<a href="%s/same">same</a><a href="https://external.example.com/other">cross</a>`,
			base,
		)
	})
	mux.HandleFunc("/same", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "same origin page")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, err := docfetch.Fetch(context.Background(), srv.URL+"/", 1, 1024*1024)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Pages) != 2 {
		t.Errorf("expected 2 pages (root + same-origin), got %d", len(result.Pages))
	}
}
