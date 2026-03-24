package config

import (
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	Env                              string
	Port                             string
	ServiceName                      string
	DatabaseURL                      string
	DBMaxConns                       int32
	DBMinConns                       int32
	RedisURL                         string
	OTELEndpoint                     string
	JWTSecret                        string
	CredentialsEncryptionKey         string
	CredentialsEncryptionKeyPrevious string // set during key rotation; cleared after re-encryption
	AllowOrigins                     []string
	// OIDC / SSO
	OIDCIssuerURL      string
	OIDCClientID       string
	OIDCClientSecret   string
	OIDCRedirectURL    string
	OIDCCompanySlug    string
	DefaultCompanySlug string
	// Google OAuth (separate from generic OIDC so both can coexist)
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURL  string
	GoogleCompanySlug  string
	// Magic link email auth
	SMTPHost  string
	SMTPPort  string
	SMTPUser  string
	SMTPPass  string
	EmailFrom string
	// Frontend base URL (used to build post-login redirect)
	FrontendURL string
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseInt32(key string, fallback int32) int32 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 32)
	if err != nil {
		return fallback
	}
	return int32(n)
}

func Load() *Config {
	// Load .env into process environment; ignore error if file is absent.
	_ = godotenv.Load()

	return &Config{
		Env:                              getEnv("ENV", "development"),
		Port:                             getEnv("PORT", "8080"),
		ServiceName:                      getEnv("SERVICE_NAME", "lima-api"),
		DatabaseURL:                      getEnv("DATABASE_URL", ""),
		DBMaxConns:                       parseInt32("DB_MAX_CONNS", 25),
		DBMinConns:                       parseInt32("DB_MIN_CONNS", 2),
		RedisURL:                         getEnv("REDIS_URL", ""),
		OTELEndpoint:                     getEnv("OTEL_ENDPOINT", "http://otel-collector:4318"),
		JWTSecret:                        getEnv("JWT_SECRET", ""),
		CredentialsEncryptionKey:         getEnv("CREDENTIALS_ENCRYPTION_KEY", getEnv("JWT_SECRET", "")),
		CredentialsEncryptionKeyPrevious: getEnv("CREDENTIALS_ENCRYPTION_KEY_PREVIOUS", ""),
		AllowOrigins:                     strings.Split(getEnv("ALLOW_ORIGINS", "http://localhost:3000"), ","),
		OIDCIssuerURL:                    getEnv("OIDC_ISSUER_URL", ""),
		OIDCClientID:                     getEnv("OIDC_CLIENT_ID", ""),
		OIDCClientSecret:                 getEnv("OIDC_CLIENT_SECRET", ""),
		OIDCRedirectURL:                  getEnv("OIDC_REDIRECT_URL", "http://localhost:8080/v1/auth/sso/callback"),
		OIDCCompanySlug:                  getEnv("OIDC_COMPANY_SLUG", ""),
		DefaultCompanySlug:               getEnv("DEFAULT_COMPANY_SLUG", ""),
		GoogleClientID:                   getEnv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret:               getEnv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURL:                getEnv("GOOGLE_REDIRECT_URL", "http://localhost:8080/v1/auth/google/callback"),
		GoogleCompanySlug:                getEnv("GOOGLE_COMPANY_SLUG", ""),
		SMTPHost:                         getEnv("SMTP_HOST", ""),
		SMTPPort:                         getEnv("SMTP_PORT", "587"),
		SMTPUser:                         getEnv("SMTP_USER", ""),
		SMTPPass:                         getEnv("SMTP_PASS", ""),
		EmailFrom:                        getEnv("EMAIL_FROM", "noreply@localhost"),
		FrontendURL:                      getEnv("FRONTEND_URL", "http://localhost:3000"),
	}
}
