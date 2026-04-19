package queue

import (
	"testing"
)

func TestStageSettings(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name         string
		baseModel    string
		baseProvider string
		override     string
		wantModel    string
	}{
		{
			name:         "no override keeps base model",
			baseModel:    "gpt-4o",
			baseProvider: "openai",
			override:     "",
			wantModel:    "gpt-4o",
		},
		{
			name:         "override replaces model",
			baseModel:    "gpt-4o",
			baseProvider: "openai",
			override:     "o1-mini",
			wantModel:    "o1-mini",
		},
		{
			name:         "override from gpt-3.5-turbo to gpt-4o",
			baseModel:    "gpt-3.5-turbo",
			baseProvider: "openai",
			override:     "gpt-4o",
			wantModel:    "gpt-4o",
		},
		{
			name:         "provider preserved when override is set",
			baseModel:    "gpt-4o",
			baseProvider: "openai",
			override:     "o1-mini",
			wantModel:    "o1-mini",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			base := userAISettings{
				Provider:     tc.baseProvider,
				Model:        tc.baseModel,
				TavilyMCPURL: "https://tavily.example.com/mcp",
				Credentials: userAICredentials{
					APIKey: "sk-test-key",
				},
			}

			got := stageSettings(base, tc.override)

			if got.Model != tc.wantModel {
				t.Errorf("Model = %q, want %q", got.Model, tc.wantModel)
			}
			// Provider must be preserved regardless of override.
			if got.Provider != base.Provider {
				t.Errorf("Provider = %q, want %q (should be preserved)", got.Provider, base.Provider)
			}
			// TavilyMCPURL (analogous to system-level config) must be preserved.
			if got.TavilyMCPURL != base.TavilyMCPURL {
				t.Errorf("TavilyMCPURL = %q, want %q (should be preserved)", got.TavilyMCPURL, base.TavilyMCPURL)
			}
			// Credentials must not be zeroed out.
			if got.Credentials.APIKey != base.Credentials.APIKey {
				t.Errorf("Credentials.APIKey = %q, want %q (should be preserved)", got.Credentials.APIKey, base.Credentials.APIKey)
			}
		})
	}
}
