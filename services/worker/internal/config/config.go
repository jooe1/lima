package config

import (
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

type Config struct {
	Env                      string
	ServiceName              string
	DatabaseURL              string
	RedisURL                 string
	OTELEndpoint             string
	CredentialsEncryptionKey string
	// Concurrency controls
	GenerationWorkers int
	SchemaWorkers     int
	ImportWorkers     int
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
		Env:                      getEnv("ENV", "development"),
		ServiceName:              getEnv("SERVICE_NAME", "lima-worker"),
		DatabaseURL:              getEnv("DATABASE_URL", ""),
		RedisURL:                 getEnv("REDIS_URL", ""),
		OTELEndpoint:             getEnv("OTEL_ENDPOINT", "http://otel-collector:4318"),
		GenerationWorkers:        getInt("GENERATION_WORKERS", 4),
		SchemaWorkers:            getInt("SCHEMA_WORKERS", 2),
		ImportWorkers:            getInt("IMPORT_WORKERS", 2),
		CredentialsEncryptionKey: getEnv("CREDENTIALS_ENCRYPTION_KEY", getEnv("JWT_SECRET", "")),
	}
}
