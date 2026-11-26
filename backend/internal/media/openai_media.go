package media

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"slices"
)

const maxImageSize = 18 << 20

type imageResponse struct {
	Usage reportedUsage `json:"usage"`
	Data  []struct {
		B64 string `json:"b64_json"`
	} `json:"data"`
}

func decodeImageResponse(body io.Reader) (imageResponse, error) {
	var result imageResponse
	// Account for the JSON envelope as well as the largest allowed Base64 payload.
	limit := int64(base64.StdEncoding.EncodedLen(maxImageSize) + (64 << 10))
	if err := json.NewDecoder(io.LimitReader(body, limit)).Decode(&result); err != nil {
		return result, err
	}
	if len(result.Data) != 1 || result.Data[0].B64 == "" {
		return result, errors.New("expected one image result")
	}
	return result, nil
}

type capabilities struct {
	Ratios     []string          `json:"aspect_ratios"`
	Durations  []int             `json:"duration_seconds"`
	Roles      []string          `json:"input_roles"`
	VideoSizes map[string]string `json:"video_sizes"`
	ImageSizes map[string]string `json:"image_sizes"`
}

func loadCapabilities(raw []byte) (capabilities, error) {
	var caps capabilities
	if err := json.Unmarshal(raw, &caps); err != nil {
		return caps, err
	}
	return caps, nil
}

func allowed(input Input, raw []byte) bool {
	caps, err := loadCapabilities(raw)
	if err != nil {
		return false
	}
	return caps.allows(input)
}

func (caps capabilities) allows(input Input) bool {
	ratio := input.Spec.Ratio
	if ratio != "" && (!slices.Contains(caps.Ratios, ratio) || !caps.hasSize(input.Operation, ratio)) {
		return false
	}
	if input.Spec.Duration != 0 && (input.Operation != "video.generate" || !slices.Contains(caps.Durations, input.Spec.Duration)) {
		return false
	}
	if len(input.Inputs) == 0 {
		return true
	}
	if len(input.Inputs) != 1 {
		return false
	}
	role := input.Inputs[0].Role
	if !slices.Contains(caps.Roles, role) {
		return false
	}
	return input.Operation == "video.generate" && role == "first_frame" || input.Operation == "image.generate" && role == "reference_image"
}

func (caps capabilities) hasSize(operation, ratio string) bool {
	if operation == "video.generate" {
		return caps.VideoSizes[ratio] != ""
	}
	return caps.ImageSizes[ratio] != ""
}

func buildSubmission(input Input, caps capabilities, model, reference string) (string, map[string]any) {
	payload := map[string]any{"model": model, "prompt": input.Prompt}
	ratio := input.Spec.Ratio
	if input.Operation == "video.generate" {
		if input.Spec.Duration > 0 {
			payload["seconds"] = input.Spec.Duration
		}
		if ratio != "" {
			payload["size"] = caps.VideoSizes[ratio]
		}
		if reference != "" {
			payload["input_reference"] = map[string]string{"image_url": reference}
		}
		return "/v1/videos", payload
	}
	payload["n"] = 1
	payload["response_format"] = "b64_json"
	if ratio != "" {
		payload["size"] = caps.ImageSizes[ratio]
	}
	if reference != "" {
		payload["images"] = []map[string]string{{"image_url": reference}}
		return "/v1/images/edits", payload
	}
	return "/v1/images/generations", payload
}
