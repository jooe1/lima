package handler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/golang-jwt/jwt/v5"
	"github.com/lima/api/internal/config"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
	"golang.org/x/oauth2"
)

type contextKey string

const (
	claimsKey       contextKey = "claims"
	stateCookieName            = "lima_oauth_state"
	stateCookieTTL             = 10 * time.Minute
	jwtTTL                     = 24 * time.Hour
)

// Claims is the JWT payload carried in every authenticated request.
type Claims struct {
	UserID      string `json:"sub"`
	CompanyID   string `json:"company_id"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	Role        string `json:"role"`
	jwt.RegisteredClaims
}

// issueJWT mints a signed Lima JWT for the given user/workspace.
func issueJWT(cfg *config.Config, u *model.User, workspaceID string, role model.WorkspaceRole) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:      u.ID,
		CompanyID:   u.CompanyID,
		WorkspaceID: workspaceID,
		Role:        string(role),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   u.ID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(jwtTTL)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(cfg.JWTSecret))
}

// randomState generates a cryptographically random base64url state string.
func randomState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// oidcProvider builds the OIDC provider from the issuer URL.
func oidcProvider(ctx context.Context, cfg *config.Config) (*oidc.Provider, error) {
	if cfg.OIDCIssuerURL == "" {
		return nil, fmt.Errorf("OIDC_ISSUER_URL not configured")
	}
	return oidc.NewProvider(ctx, cfg.OIDCIssuerURL)
}

// SSOLogin generates the OIDC authorization URL and redirects the browser.
func SSOLogin(cfg *config.Config, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		provider, err := oidcProvider(r.Context(), cfg)
		if err != nil {
			log.Error("oidc provider init", zap.Error(err))
			respondErr(w, http.StatusServiceUnavailable, "oidc_unavailable", "SSO provider not reachable")
			return
		}

		state, err := randomState()
		if err != nil {
			respondErr(w, http.StatusInternalServerError, "state_error", "failed to generate state")
			return
		}

		oauth2Cfg := &oauth2.Config{
			ClientID:     cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret,
			RedirectURL:  cfg.OIDCRedirectURL,
			Endpoint:     provider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		}

		http.SetCookie(w, &http.Cookie{
			Name:     stateCookieName,
			Value:    state,
			Path:     "/",
			MaxAge:   int(stateCookieTTL.Seconds()),
			HttpOnly: true,
			Secure:   cfg.Env != "development",
			SameSite: http.SameSiteLaxMode,
		})

		http.Redirect(w, r, oauth2Cfg.AuthCodeURL(state), http.StatusFound)
	}
}

// SSOCallback handles the OIDC authorization code callback.
func SSOCallback(cfg *config.Config, s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Verify state to prevent CSRF.
		stateCookie, err := r.Cookie(stateCookieName)
		if err != nil || r.URL.Query().Get("state") != stateCookie.Value {
			respondErr(w, http.StatusBadRequest, "invalid_state", "OAuth state mismatch")
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     stateCookieName,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
		})

		provider, err := oidcProvider(r.Context(), cfg)
		if err != nil {
			log.Error("oidc provider init", zap.Error(err))
			respondErr(w, http.StatusServiceUnavailable, "oidc_unavailable", "SSO provider not reachable")
			return
		}

		oauth2Cfg := &oauth2.Config{
			ClientID:     cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret,
			RedirectURL:  cfg.OIDCRedirectURL,
			Endpoint:     provider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		}

		code := r.URL.Query().Get("code")
		if code == "" {
			respondErr(w, http.StatusBadRequest, "missing_code", "authorization code missing")
			return
		}

		oauth2Token, err := oauth2Cfg.Exchange(r.Context(), code)
		if err != nil {
			log.Error("oauth2 exchange", zap.Error(err))
			respondErr(w, http.StatusBadRequest, "token_exchange_failed", "code exchange failed")
			return
		}

		rawIDToken, ok := oauth2Token.Extra("id_token").(string)
		if !ok {
			respondErr(w, http.StatusBadRequest, "no_id_token", "id_token missing from IdP response")
			return
		}

		verifier := provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID})
		idToken, err := verifier.Verify(r.Context(), rawIDToken)
		if err != nil {
			log.Error("id token verify", zap.Error(err))
			respondErr(w, http.StatusUnauthorized, "invalid_id_token", "id_token verification failed")
			return
		}

		var idClaims struct {
			Email string `json:"email"`
			Name  string `json:"name"`
		}
		if err := idToken.Claims(&idClaims); err != nil {
			respondErr(w, http.StatusInternalServerError, "claims_error", "failed to parse id_token claims")
			return
		}
		if idClaims.Email == "" {
			respondErr(w, http.StatusBadRequest, "missing_email", "email claim missing from id_token")
			return
		}

		// Derive company slug from email domain.
		domain := strings.SplitN(idClaims.Email, "@", 2)
		companySlug := "company"
		if len(domain) == 2 {
			companySlug = strings.ReplaceAll(strings.Split(domain[1], ".")[0], "-", "")
		}
		company, err := s.FindOrCreateCompany(r.Context(), companySlug, companySlug)
		if err != nil {
			log.Error("find or create company", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to resolve company")
			return
		}

		user, err := s.UpsertUserSSO(r.Context(), company.ID, idClaims.Email, idClaims.Name, idToken.Subject)
		if err != nil {
			log.Error("upsert user sso", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to resolve user")
			return
		}

		// Issue JWT; workspace is resolved by the frontend after login.
		tokenStr, err := issueJWT(cfg, user, "", model.RoleEndUser)
		if err != nil {
			respondErr(w, http.StatusInternalServerError, "jwt_error", "failed to issue token")
			return
		}

		redirectURL := fmt.Sprintf("%s/auth/callback?token=%s", cfg.FrontendURL, tokenStr)
		http.Redirect(w, r, redirectURL, http.StatusFound)
	}
}

// DevLogin is only registered in development environments.
// It accepts {email, name, company_slug, role} and issues a JWT for local testing.
func DevLogin(cfg *config.Config, s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Email       string `json:"email"`
			Name        string `json:"name"`
			CompanySlug string `json:"company_slug"`
			Role        string `json:"role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if req.Email == "" {
			respondErr(w, http.StatusBadRequest, "bad_request", "email is required")
			return
		}
		if req.CompanySlug == "" {
			req.CompanySlug = "dev"
		}
		if req.Name == "" {
			req.Name = req.Email
		}

		company, err := s.FindOrCreateCompany(r.Context(), req.CompanySlug, req.CompanySlug)
		if err != nil {
			log.Error("dev login find company", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to resolve company")
			return
		}

		user, err := s.CreateUser(r.Context(), company.ID, req.Email, req.Name)
		if err != nil {
			log.Error("dev login create user", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to create user")
			return
		}

		role := model.WorkspaceRole(req.Role)
		switch role {
		case model.RoleWorkspaceAdmin, model.RoleAppBuilder, model.RoleEndUser:
		default:
			role = model.RoleWorkspaceAdmin
		}

		tokenStr, err := issueJWT(cfg, user, "", role)
		if err != nil {
			respondErr(w, http.StatusInternalServerError, "jwt_error", "failed to issue token")
			return
		}
		respond(w, http.StatusOK, map[string]any{
			"token":   tokenStr,
			"user_id": user.ID,
			"company": company,
		})
	}
}

// Logout is stateless: the client discards the JWT.
func Logout(w http.ResponseWriter, r *http.Request) {
	respond(w, http.StatusOK, map[string]string{"status": "logged_out"})
}

// Authenticate is JWT middleware. It reads the Bearer token, validates the
// signature, and injects the Claims into the request context.
func Authenticate(jwtSecret string) func(http.Handler) http.Handler {
	secret := []byte(jwtSecret)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if raw == "" {
				respondErr(w, http.StatusUnauthorized, "missing_token", "authorization header required")
				return
			}

			claims := &Claims{}
			token, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
				if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
				}
				return secret, nil
			}, jwt.WithExpirationRequired(), jwt.WithIssuedAt())

			if err != nil || !token.Valid {
				respondErr(w, http.StatusUnauthorized, "invalid_token", "token validation failed")
				return
			}

			if claims.UserID == "" || claims.CompanyID == "" {
				respondErr(w, http.StatusUnauthorized, "invalid_claims", "token missing required claims")
				return
			}

			if claims.IssuedAt != nil && claims.IssuedAt.After(time.Now().Add(24*time.Hour)) {
				respondErr(w, http.StatusUnauthorized, "invalid_claims", "token issued in the future")
				return
			}

			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClaimsFromContext retrieves Claims injected by the Authenticate middleware.
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}
