package config

import (
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

type Config struct {
	Env                              string
	ServiceName                      string
	DatabaseURL                      string
	DBMaxConns                       int32
	DBMinConns                       int32
	RedisURL                         string
	OTELEndpoint                     string
	CredentialsEncryptionKey         string
	CredentialsEncryptionKeyPrevious string
	// Concurrency controls
	GenerationWorkers int
	SchemaWorkers     int
	// TavilyMCPURL is the full Tavily MCP endpoint URL (including the API key
	// query parameter). When set, the generation agent will have access to a
	// web-search tool so it can resolve API endpoints without asking the user.
	TavilyMCPURL string
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func Load() *Config {
	_ = godotenv.Load()

	return &Config{
		Env:                              getEnv("ENV", "development"),
		ServiceName:                      getEnv("SERVICE_NAME", "lima-worker"),
		DatabaseURL:                      getEnv("DATABASE_URL", ""),
		DBMaxConns:                       int32(getInt("DB_MAX_CONNS", 10)),
		DBMinConns:                       int32(getInt("DB_MIN_CONNS", 1)),
		RedisURL:                         getEnv("REDIS_URL", ""),
		OTELEndpoint:                     getEnv("OTEL_ENDPOINT", "http://otel-collector:4318"),
		GenerationWorkers:                getInt("GENERATION_WORKERS", 4),
		SchemaWorkers:                    getInt("SCHEMA_WORKERS", 2),
		CredentialsEncryptionKey:         getEnv("CREDENTIALS_ENCRYPTION_KEY", getEnv("JWT_SECRET", "")),
		CredentialsEncryptionKeyPrevious: getEnv("CREDENTIALS_ENCRYPTION_KEY_PREVIOUS", ""),
		TavilyMCPURL:                     getEnv("TAVILY_MCP_URL", ""),
	}
}
