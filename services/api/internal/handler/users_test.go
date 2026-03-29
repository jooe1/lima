package handler

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"
)

// languageStoreStub is a test double for userLanguageStore.
type languageStoreStub struct {
	err      error
	lastUser string
	lastLang string
}

func (s *languageStoreStub) SetUserLanguage(_ context.Context, userID, lang string) error {
	s.lastUser = userID
	s.lastLang = lang
	return s.err
}

// buildLanguageHandler wraps PatchMyLanguage behind the Authenticate middleware
// so that JWT validation and claims injection work exactly as in production.
func buildLanguageHandler(t *testing.T, stub *languageStoreStub) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("/v1/me/language", Authenticate(testJWTSecret)(PatchMyLanguage(stub, zap.NewNop())))
	return mux
}

func TestPatchMyLanguageHappyPath(t *testing.T) {
	stub := &languageStoreStub{}
	h := buildLanguageHandler(t, stub)

	body := bytes.NewBufferString(`{"language":"de"}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/me/language", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+makeTestJWT(t, "user-1", "company-1"))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Errorf("PatchMyLanguage happy path: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
	if stub.lastUser != "user-1" {
		t.Errorf("SetUserLanguage userID = %q, want %q", stub.lastUser, "user-1")
	}
	if stub.lastLang != "de" {
		t.Errorf("SetUserLanguage lang = %q, want %q", stub.lastLang, "de")
	}
}

func TestPatchMyLanguageRejectsUnsupportedLang(t *testing.T) {
	stub := &languageStoreStub{}
	h := buildLanguageHandler(t, stub)

	body := bytes.NewBufferString(`{"language":"fr"}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/me/language", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+makeTestJWT(t, "user-1", "company-1"))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("PatchMyLanguage unsupported lang: status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
	if stub.lastLang != "" {
		t.Errorf("SetUserLanguage should not have been called, but lastLang = %q", stub.lastLang)
	}
	if !strings.Contains(rr.Body.String(), "unsupported_language") {
		t.Errorf("PatchMyLanguage unsupported lang: body = %s, want unsupported_language code", rr.Body.String())
	}
}

func TestPatchMyLanguageRequiresAuth(t *testing.T) {
	stub := &languageStoreStub{}
	h := buildLanguageHandler(t, stub)

	body := bytes.NewBufferString(`{"language":"de"}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/me/language", body)
	req.Header.Set("Content-Type", "application/json")
	// No Authorization header

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("PatchMyLanguage unauthenticated: status = %d, want 401; body = %s", rr.Code, rr.Body.String())
	}
	if stub.lastLang != "" {
		t.Errorf("SetUserLanguage should not have been called, but lastLang = %q", stub.lastLang)
	}
}
