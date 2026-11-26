package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/accounts"
	"ai-gateway/internal/app"
	"ai-gateway/internal/catalog"
	"ai-gateway/internal/coding"
	"ai-gateway/internal/console"
	"ai-gateway/internal/media"
	"ai-gateway/internal/metering"
	"ai-gateway/internal/platform"
	"ai-gateway/internal/schema"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	key, err := platform.Secret("KEY_DIGEST_SECRET")
	if err != nil {
		log.Fatal(err)
	}
	enc, err := platform.Secret("CONNECTION_SECRET")
	if err != nil {
		log.Fatal(err)
	}
	dsn, public, dir := os.Getenv("DATABASE_URL"), strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/"), os.Getenv("MEDIA_STORAGE_DIR")
	if dsn == "" || public == "" || dir == "" {
		log.Fatal("DATABASE_URL, PUBLIC_BASE_URL and MEDIA_STORAGE_DIR are required")
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		log.Fatal(err)
	}
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err = schema.Check(ctx, db); err != nil {
		log.Fatal(err)
	}
	workerDB, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer workerDB.Close()
	store := access.Store{DB: db, Key: key, Secure: strings.HasPrefix(public, "https://")}
	registry := catalog.Store{DB: db, Key: enc}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client := func(headerTimeout time.Duration) *http.Client {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		transport.ResponseHeaderTimeout = headerTimeout
		return &http.Client{Transport: transport, CheckRedirect: noRedirect}
	}
	hosts := map[string]bool{}
	for _, v := range strings.Split(os.Getenv("JIMENG_DOWNLOAD_HOSTS"), ",") {
		if host := strings.TrimSpace(strings.ToLower(v)); host != "" {
			hosts[host] = true
		}
	}
	// The synchronous image endpoint can take longer than the usual response header timeout.
	tasks := &media.Service{DB: workerDB, Catalog: catalog.Store{DB: workerDB, Key: enc}, Dir: dir,
		Client: client(60 * time.Second), ImageClient: client(0), DownloadHosts: hosts, CursorKey: key}
	providerRegistry, err := loadProviders()
	if err != nil {
		log.Fatal(err)
	}
	accountService := accounts.Service{DB: db, Key: enc, Providers: providerRegistry}
	a := app.App{DB: db, Access: store, Media: tasks,
		Coding: &coding.Service{Access: store, Catalog: registry, Metrics: metering.Store{DB: db}, Client: client(60 * time.Second)},
		Console: console.Service{
			DB: db, Store: store, Catalog: registry, PublicBase: public,
			AccountsService: accountService,
		},
	}
	workersDone := make(chan struct{})
	go func() {
		defer close(workersDone)
		tasks.Run(ctx)
	}()
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				sweep, stop := context.WithTimeout(ctx, 2*time.Minute)
				err := tasks.Sweep(sweep, media.Retention{SessionsBefore: now, AssetsBefore: now.AddDate(0, 0, -30), OrphansBefore: now.Add(-24 * time.Hour), IdempotencyBefore: now.AddDate(0, 0, -30), RequestsBefore: now.AddDate(0, 0, -30), AuditBefore: now.AddDate(0, 0, -90)})
				stop()
				if err != nil {
					log.Printf("retention sweep: %v", err)
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				renewal, cancel := context.WithTimeout(ctx, 30*time.Second)
				if err := accountService.RefreshDue(renewal); err != nil && ctx.Err() == nil {
					log.Print("account credential refresh state unavailable")
				}
				cancel()
			}
		}
	}()
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	server := http.Server{Addr: addr, Handler: a.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	go func() {
		log.Printf("gateway listening on %s", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	draining, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	if err := server.Shutdown(draining); err != nil {
		_ = server.Close()
	}
	select {
	case <-workersDone:
	case <-draining.Done():
	}
}
