package cryptoutil

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
)

func deriveKey(secret string) ([]byte, error) {
	if secret == "" {
		return nil, fmt.Errorf("credentials encryption key is not configured")
	}
	sum := sha256.Sum256([]byte(secret))
	return sum[:], nil
}

func Encrypt(secret string, plaintext []byte) ([]byte, error) {
	key, err := deriveKey(secret)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("new cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("new gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("read nonce: %w", err)
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

func Decrypt(secret string, ciphertext []byte) ([]byte, error) {
	key, err := deriveKey(secret)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("new cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("new gcm: %w", err)
	}
	if len(ciphertext) < gcm.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	nonce := ciphertext[:gcm.NonceSize()]
	data := ciphertext[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, data, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	return plaintext, nil
}

// DecryptWithRotation tries the current key first; if decryption fails it
// falls back to previousSecret (the key that was active before rotation).
// Use this during the transition window when both old and new keys are valid.
// Once all ciphertexts have been re-encrypted with the new key, remove
// CREDENTIALS_ENCRYPTION_KEY_PREVIOUS from the environment.
func DecryptWithRotation(currentSecret, previousSecret string, ciphertext []byte) ([]byte, error) {
	pt, err := Decrypt(currentSecret, ciphertext)
	if err == nil {
		return pt, nil
	}
	if previousSecret == "" {
		return nil, err // no fallback available
	}
	pt, err2 := Decrypt(previousSecret, ciphertext)
	if err2 != nil {
		// Return the original error so callers see "decrypt failed", not the
		// fallback error which might be confusing.
		return nil, fmt.Errorf("decrypt with current key: %w; decrypt with previous key: %v", err, err2)
	}
	return pt, nil
}
