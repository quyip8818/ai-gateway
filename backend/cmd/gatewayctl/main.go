package main

import (
	"context"
	"log"
	"os"
	"time"

	"ai-gateway/internal/schema"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: gatewayctl init-db | gatewayctl bootstrap")
	}
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL required")
	}
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	switch os.Args[1] {
	case "init-db":
		if len(os.Args) != 2 {
			log.Fatal("usage: gatewayctl init-db")
		}
		if err = schema.Initialize(ctx, db); err != nil {
			log.Fatal(err)
		}
	case "bootstrap":
		if len(os.Args) != 2 {
			log.Fatal("usage: gatewayctl bootstrap (password on stdin)")
		}
		if err = schema.Check(ctx, db); err != nil {
			log.Fatal(err)
		}
		if err = bootstrap(ctx, db, os.Getenv("BOOTSTRAP_USERNAME"), os.Stdin); err != nil {
			log.Fatal(err)
		}
	default:
		log.Fatal("unknown command")
	}
}
