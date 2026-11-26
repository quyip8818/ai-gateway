package platform

import (
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Cursor struct {
	Created time.Time `json:"time"`
	ID      string    `json:"id"`
}

func Pagination(q url.Values, key []byte, scope string) (limit int, after Cursor, err error) {
	limit = 50
	if v := q.Get("limit"); v != "" {
		limit, err = strconv.Atoi(v)
		if err != nil || limit < 1 || limit > 100 {
			return 0, after, errors.New("invalid limit")
		}
	}
	if v := q.Get("cursor"); v != "" {
		body, sig, ok := strings.Cut(v, ".")
		mac, e := base64.RawURLEncoding.DecodeString(sig)
		if !ok || e != nil || !hmac.Equal(mac, Digest(key, "page:"+scope+":"+body)) {
			return 0, after, errors.New("invalid cursor")
		}
		data, e := base64.RawURLEncoding.DecodeString(body)
		if e != nil || json.Unmarshal(data, &after) != nil || after.Created.IsZero() || after.ID == "" {
			return 0, after, errors.New("invalid cursor")
		}
	}
	return limit, after, nil
}
func PageToken(key []byte, scope string, after Cursor) string {
	raw, _ := json.Marshal(after)
	body := base64.RawURLEncoding.EncodeToString(raw)
	return body + "." + base64.RawURLEncoding.EncodeToString(Digest(key, "page:"+scope+":"+body))
}
