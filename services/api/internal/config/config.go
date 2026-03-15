package config

import (
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	Env             string
	Port            string
	ServiceName     string
	DatabaseURL     string
	RedisURL        string
	OTELEndpoint    string
	JWTSecret       string
	AllowOrigins    []string
	// OIDC / SSO
	OIDCIssuerURL    string
	OIDCClientID     string
	OIDCClientSecret string
	OIDCRedirectURL  string
	// Frontend base URL (used to build post-login redirect)
	FrontendURL string
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func Load() *Config {
	// Load .env into process environment; ignore error if file is absent.
	_ = godotenv.Load()

	return &Config{
		Env:              getEnv("ENV", "development"),
		Port:             getEnv("PORT", "8080"),
		ServiceName:      getEnv("SERVICE_NAME", "lima-api"),
		DatabaseURL:      getEnv("DATABASE_URL", ""),
		RedisURL:         getEnv("REDIS_URL", ""),
		OTELEndpoint:     getEnv("OTEL_ENDPOINT", "http://otel-collector:4318"),
		JWTSecret:        getEnv("JWT_SECRET", ""),
		AllowOrigins:     strings.Split(getEnv("ALLOW_ORIGINS", "http://localhost:3000"), ","),
		OIDCIssuerURL:    getEnv("OIDC_ISSUER_URL", ""),
		OIDCClientID:     getEnv("OIDC_CLIENT_ID", ""),
		OIDCClientSecret: getEnv("OIDC_CLIENT_SECRET", ""),
		OIDCRedirectURL:  getEnv("OIDC_REDIRECT_URL", "http://localhost:8080/v1/auth/sso/callback"),
		FrontendURL:      getEnv("FRONTEND_URL", "http://localhost:3000"),
	}
}
