package media

import (
	"encoding/base64"
	"io"
	"strings"
	"testing"
)

func TestImageResponseAtSizeLimit(t *testing.T) {
	encodedSize := base64.StdEncoding.EncodedLen(maxImageSize)
	body := io.MultiReader(
		strings.NewReader(`{"created":42,"data":[{"b64_json":"`),
		strings.NewReader(strings.Repeat("A", encodedSize)),
		strings.NewReader(`"}]}`),
	)
	result, err := decodeImageResponse(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Data[0].B64) != encodedSize {
		t.Fatal("image payload was truncated")
	}
}

func TestImageSubmission(t *testing.T) {
	input := Input{Operation: "image.generate", Prompt: "fixture"}
	input.Spec.Ratio = "1:1"
	const reference = "data:image/png;base64,fixture"

	caps := capabilities{Ratios: []string{"1:1"}, ImageSizes: map[string]string{"1:1": "1024x1024"}}
	if !caps.allows(input) {
		t.Fatal("configured image size was rejected")
	}
	path, body := buildSubmission(input, caps, "model", "")
	if path != "/v1/images/generations" || body["size"] != "1024x1024" || body["ratio"] != nil {
		t.Fatalf("unexpected generation request: %s %#v", path, body)
	}
	path, body = buildSubmission(input, caps, "model", reference)
	if path != "/v1/images/edits" || body["size"] != "1024x1024" || body["images"] == nil {
		t.Fatalf("unexpected edit request: %s %#v", path, body)
	}
	delete(caps.ImageSizes, "1:1")
	if caps.allows(input) {
		t.Fatal("unconfigured aspect ratio was accepted")
	}
}
