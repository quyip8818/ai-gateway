// Package protocol describes the wire contracts independent of account providers.
package protocol

import "net/http"

type Kind string

const (
	Responses Kind = "responses"
	Messages  Kind = "messages"
	Media     Kind = "openai_media"
)

const (
	ImageGenerate = "image.generate"
	VideoGenerate = "video.generate"
)

// DefaultOperation is used for catalogs whose models share one operation.
func (p Kind) DefaultOperation() string {
	switch p {
	case Responses, Messages:
		return string(p)
	default:
		return ""
	}
}

func (p Kind) Authorize(headers http.Header, token string, caller http.Header) {
	if p != Messages {
		headers.Set("Authorization", "Bearer "+token)
		return
	}
	headers.Set("x-api-key", token)
	version := caller.Get("anthropic-version")
	if version == "" {
		version = "2023-06-01"
	}
	headers.Set("anthropic-version", version)
	for _, beta := range caller.Values("anthropic-beta") {
		headers.Add("anthropic-beta", beta)
	}
}
