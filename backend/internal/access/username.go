package access

import "strings"

func NormalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
