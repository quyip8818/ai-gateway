package platform

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
)

func ID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	s := hex.EncodeToString(b)
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

func Random() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func Secret(name string) ([]byte, error) {
	value := os.Getenv(name)
	if path := os.Getenv(name + "_FILE"); path != "" {
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		value = strings.TrimSpace(string(content))
	}
	b, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(b) != 32 {
		return nil, errors.New(name + " must contain 32 bytes encoded as base64")
	}
	return b, nil
}

func Digest(key []byte, value string) []byte {
	sum := hmac.New(sha256.New, key)
	sum.Write([]byte(value))
	return sum.Sum(nil)
}

func Seal(key []byte, context, value string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	rand.Read(nonce)
	return g.Seal(nonce, nonce, []byte(value), []byte(context)), nil
}

func Open(key, value []byte, context string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(value) < g.NonceSize() {
		return "", errors.New("invalid ciphertext")
	}
	raw, err := g.Open(nil, value[:g.NonceSize()], value[g.NonceSize():], []byte(context))
	return string(raw), err
}

func JSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func Error(w http.ResponseWriter, code int, message string) {
	JSON(w, code, map[string]any{"error": map[string]string{"code": message, "message": message, "request_id": w.Header().Get("X-Request-Id")}})
}
