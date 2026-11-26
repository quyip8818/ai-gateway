package console

import (
	"testing"

	"ai-gateway/internal/catalog"
)

func TestJimengConnectionDraft(t *testing.T) {
	const base = "http://jimeng:8000"
	provider, _ := catalog.LookupProvider("jimeng")
	t.Run("key only", func(t *testing.T) {
		draft := connectionDraft{Provider: "jimeng", Token: "jm_test"}
		if !draft.prepare(provider, base) || draft.Base != base || draft.Label != "即梦" ||
			draft.Quota != "jimeng" || draft.Region != "" || draft.VideoIdempotencyVerified {
			t.Fatalf("unexpected connection defaults")
		}
	})
	t.Run("explicit legacy fields", func(t *testing.T) {
		draft := connectionDraft{
			Provider: "jimeng", Token: "old-key", Base: base, Label: "existing",
			Quota: "shared", Region: "cn", VideoIdempotencyVerified: true,
		}
		before := draft
		if !draft.prepare(provider, base) || draft != before {
			t.Fatal("explicit connection settings changed")
		}
	})
	t.Run("missing deployment address", func(t *testing.T) {
		draft := connectionDraft{Provider: "jimeng", Token: "jm_test"}
		if draft.prepare(provider, "") {
			t.Fatal("accepted a connection without a deployment base")
		}
	})
}
