package handler

import (
	"context"
	"net/http"

	"go.uber.org/zap"
)

// userLanguageStore is the narrow interface required by PatchMyLanguage.
// *store.Store satisfies this interface.
type userLanguageStore interface {
	SetUserLanguage(ctx context.Context, userID, lang string) error
}

// PatchMyLanguage handles PATCH /v1/me/language.
// Body: {"language": "en" | "de"} → 204 No Content.
// Returns 400 if the language value is not supported.
func PatchMyLanguage(s userLanguageStore, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFromContext(r.Context())
		if !ok {
			respondErr(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
			return
		}

		var body struct {
			Language string `json:"language"`
		}
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}

		if body.Language != "en" && body.Language != "de" {
			respondErr(w, http.StatusBadRequest, "unsupported_language", "language must be one of: en, de")
			return
		}

		if err := s.SetUserLanguage(r.Context(), claims.UserID, body.Language); err != nil {
			log.Error("set user language", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to update language")
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
