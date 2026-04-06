package docfetch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var ErrBlockedHost = errors.New("host is blocked for security reasons")
var ErrUnsupportedScheme = errors.New("URL scheme is not supported")

// LookupHostFn is the DNS resolution function used for SSRF mitigation.
// It can be replaced in tests.
var LookupHostFn = net.LookupHost

// FetchResult holds all pages fetched during a Fetch call.
type FetchResult struct {
	Pages []FetchedPage
}

// FetchedPage is a single fetched page with its URL and body text.
type FetchedPage struct {
	URL  string
	Body string
}

var hrefRe = regexp.MustCompile(`href=["']([^"']+)["']`)

// tagRe matches any HTML tag.
var tagRe = regexp.MustCompile(`<[^>]+>`)

// scriptStyleRe matches <script>...</script> and <style>...</style> blocks.
var scriptStyleRe = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)

// stripHTML removes script/style blocks and all HTML tags, collapsing
// whitespace so the AI receives plain readable text.
func stripHTML(s string) string {
	s = scriptStyleRe.ReplaceAllString(s, " ")
	s = tagRe.ReplaceAllString(s, " ")
	// collapse runs of whitespace to single spaces / newlines
	lines := strings.Split(s, "\n")
	var kept []string
	for _, l := range lines {
		l = strings.Join(strings.Fields(l), " ")
		if l != "" {
			kept = append(kept, l)
		}
	}
	return strings.Join(kept, "\n")
}

var privateNets []*net.IPNet

func init() {
	for _, cidr := range []string{
		"127.0.0.0/8",
		"169.254.0.0/16",
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
	} {
		_, ipNet, _ := net.ParseCIDR(cidr)
		privateNets = append(privateNets, ipNet)
	}
}

func isBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return true
	}
	for _, n := range privateNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func checkHost(host string) error {
	hostname := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		hostname = h
	}
	addrs, err := LookupHostFn(hostname)
	if err != nil {
		return err
	}
	for _, addr := range addrs {
		if ip := net.ParseIP(addr); ip != nil && isBlockedIP(ip) {
			return ErrBlockedHost
		}
	}
	return nil
}

func doFetch(ctx context.Context, rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	if err := checkHost(u.Host); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("non-2xx status %d fetching %s", resp.StatusCode, rawURL)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func extractLinks(body, rawBase string) []string {
	base, err := url.Parse(rawBase)
	if err != nil {
		return nil
	}
	matches := hrefRe.FindAllStringSubmatch(body, -1)
	seen := make(map[string]bool)
	var out []string
	for _, m := range matches {
		ref, err := url.Parse(m[1])
		if err != nil {
			continue
		}
		abs := base.ResolveReference(ref).String()
		if !seen[abs] {
			seen[abs] = true
			out = append(out, abs)
		}
	}
	return out
}

func sameOrigin(a, b *url.URL) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
}

// Fetch retrieves rootURL and, if maxDepth >= 1, all same-origin linked pages.
// maxBytes is a cumulative cap on total Body content; fetching stops once it is
// reached. Context deadlines govern all HTTP requests; no internal timeouts are
// set. A non-2xx or network error on the root page returns a non-nil error. Errors
// on linked pages are silently skipped. The first element of FetchResult.Pages is
// always the root page.
func Fetch(ctx context.Context, rootURL string, maxDepth int, maxBytes int) (*FetchResult, error) {
	rootParsed, err := url.Parse(rootURL)
	if err != nil {
		return nil, err
	}
	if rootParsed.Scheme != "http" && rootParsed.Scheme != "https" {
		return nil, ErrUnsupportedScheme
	}

	result := &FetchResult{}
	totalBytes := 0

	rootRaw, err := doFetch(ctx, rootURL)
	if err != nil {
		return nil, fmt.Errorf("fetching root %s: %w", rootURL, err)
	}
	rootStripped := stripHTML(rootRaw)
	totalBytes += len(rootStripped)
	result.Pages = append(result.Pages, FetchedPage{URL: rootURL, Body: rootStripped})

	if maxDepth < 1 || totalBytes >= maxBytes {
		return result, nil
	}

	// Extract links from raw HTML before stripping so href attributes are intact.
	links := extractLinks(rootRaw, rootURL)
	for _, link := range links {
		linkParsed, err := url.Parse(link)
		if err != nil {
			continue
		}
		if !sameOrigin(rootParsed, linkParsed) {
			continue
		}
		if link == rootURL {
			continue
		}
		linkRaw, err := doFetch(ctx, link)
		if err != nil {
			continue // silently skip failures for linked pages
		}
		linkStripped := stripHTML(linkRaw)
		totalBytes += len(linkStripped)
		result.Pages = append(result.Pages, FetchedPage{URL: link, Body: linkStripped})
		if totalBytes >= maxBytes {
			break
		}
	}

	return result, nil
}
