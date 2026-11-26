package providers

import (
	"encoding/json"
	"errors"
	"maps"
	"regexp"
	"strings"

	"ai-gateway/internal/protocol"
)

var providerID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)

// Compatible configures an operator-owned upstream using an existing wire contract.
type Compatible struct {
	ID          string            `json:"id"`
	Label       string            `json:"label"`
	Base        string            `json:"base_url"`
	Protocol    protocol.Kind     `json:"protocol"`
	CountTokens bool              `json:"count_tokens,omitempty"`
	MediaModels map[string]string `json:"media_models,omitempty"`
}

func (r Registry) WithCompatible(configs []Compatible) (Registry, error) {
	r.adapters = r.All()
	for _, config := range configs {
		base := strings.TrimRight(config.Base, "/")
		label := strings.TrimSpace(config.Label)
		_, exists := r.Get(config.ID)
		if exists || !providerID.MatchString(config.ID) || label == "" || len(label) > 80 ||
			!validBase(base) || (config.Protocol.DefaultOperation() == "" && config.Protocol != protocol.Media) ||
			(config.CountTokens && config.Protocol != protocol.Messages) {
			return Registry{}, errors.New("invalid compatible provider configuration")
		}
		adapter := Adapter{
			ID: config.ID, Label: label, Format: "platform_key", CredentialLabel: "上游 API Key", Base: base, Protocol: config.Protocol,
			CountTokens: config.CountTokens, parse: parsePlatformKey,
		}
		if (config.Protocol == protocol.Media) != (len(config.MediaModels) > 0) {
			return Registry{}, errors.New("openai_media requires explicit media_models")
		}
		if config.Protocol == protocol.Media {
			models := maps.Clone(config.MediaModels)
			for id, operation := range models {
				if !modelID.MatchString(id) || (operation != protocol.ImageGenerate && operation != protocol.VideoGenerate) {
					return Registry{}, errors.New("invalid compatible media model")
				}
			}
			adapter.model = func(item directoryModel) (string, json.RawMessage) {
				return models[item.ID], item.Capabilities
			}
		}
		r.adapters = append(r.adapters, adapter)
	}
	return r, nil
}
