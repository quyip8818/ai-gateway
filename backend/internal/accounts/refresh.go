package accounts

import (
	"context"
	"errors"
	"time"

	"ai-gateway/internal/platform"
	"ai-gateway/internal/providers"
	"github.com/jackc/pgx/v5"
)

type refreshClaim struct {
	account, provider string
	version           int64
	sealed            []byte
}

// RefreshDue refreshes one due credential. An expired claim is ambiguous and
// requires reauthorization instead of retrying a potentially rotated refresh token.
func (s Service) RefreshDue(ctx context.Context) error {
	if _, err := s.DB.Exec(ctx, `UPDATE upstream_accounts SET refresh_state='reauthorize',refresh_deadline=NULL
 WHERE refresh_state='refreshing' AND refresh_deadline<=now()`); err != nil {
		return err
	}
	var claim refreshClaim
	err := s.DB.QueryRow(ctx, `WITH due AS (
 SELECT a.id,p.provider FROM upstream_accounts a JOIN account_pools p ON p.id=a.pool_id
 WHERE a.enabled AND a.refresh_secret IS NOT NULL AND a.refresh_state='ready' AND a.expires_at<=now()+interval '90 seconds'
 ORDER BY a.expires_at,a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED
 )
 UPDATE upstream_accounts a SET refresh_state='refreshing',refresh_deadline=now()+interval '60 seconds',
 credential_version=a.credential_version+1 FROM due
 WHERE a.id=due.id RETURNING a.id,due.provider,a.credential_version,a.refresh_secret`).
		Scan(&claim.account, &claim.provider, &claim.version, &claim.sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	request, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := s.refresh(request, claim); err != nil {
		_, updateErr := s.DB.Exec(ctx, `UPDATE upstream_accounts SET refresh_state='reauthorize',refresh_deadline=NULL
 WHERE id=$1 AND credential_version=$2 AND refresh_state='refreshing'`, claim.account, claim.version)
		return updateErr
	}
	return nil
}

func (s Service) refresh(ctx context.Context, claim refreshClaim) error {
	adapter, ok := s.Providers.Get(claim.provider)
	if !ok {
		return providers.ErrDisabled
	}
	refreshToken, err := platform.Open(s.Key, claim.sealed, claim.account+"/refresh")
	if err != nil {
		return err
	}
	next, err := s.Providers.Refresh(ctx, adapter, providers.Credential{RefreshToken: refreshToken, Personal: true})
	if err != nil {
		return err
	}
	token, err := platform.Seal(s.Key, claim.account, next.Token)
	if err != nil {
		return err
	}
	refresh, err := platform.Seal(s.Key, claim.account+"/refresh", next.RefreshToken)
	if err != nil {
		return err
	}
	tag, err := s.DB.Exec(ctx, `UPDATE upstream_accounts SET execution_secret=$3,refresh_secret=$4,expires_at=$5,
 credential_fingerprint=$6,refresh_state='ready',refresh_deadline=NULL
 WHERE id=$1 AND credential_version=$2 AND refresh_state='refreshing' AND refresh_deadline>now()`,
		claim.account, claim.version, token, refresh, next.ExpiresAt, platform.Digest(s.Key, claim.provider+"\x00"+next.Token))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return providers.ErrUpstream
	}
	return nil
}
