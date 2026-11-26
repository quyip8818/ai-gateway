package media

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DownloadHostStore struct{ DB *pgxpool.Pool }

var ErrInvalidDownloadHosts = errors.New("invalid_download_hosts")

var dnsHostname = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)

func (s DownloadHostStore) Replace(ctx context.Context, values []string) error {
	if len(values) > 32 {
		return ErrInvalidDownloadHosts
	}
	hosts := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		host := strings.ToLower(strings.TrimSpace(value))
		if len(host) > 253 || !dnsHostname.MatchString(host) {
			return ErrInvalidDownloadHosts
		}
		if !seen[host] {
			hosts = append(hosts, host)
			seen[host] = true
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(61912344)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM media_download_hosts"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO media_download_hosts(hostname) SELECT unnest($1::text[])", hosts); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s DownloadHostStore) List(ctx context.Context) ([]string, error) {
	rows, err := s.DB.Query(ctx, "SELECT hostname FROM media_download_hosts ORDER BY hostname")
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (s DownloadHostStore) Allows(ctx context.Context, hostname string) bool {
	var allowed bool
	err := s.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM media_download_hosts WHERE hostname=$1)", hostname).Scan(&allowed)
	return err == nil && allowed
}
