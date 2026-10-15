package main

import (
	"log"
	"net/http"
	"path/filepath"
	"time"

	"simplemusic/internal/api"
	"simplemusic/internal/auth"
	"simplemusic/internal/config"
	"simplemusic/internal/media"
	"simplemusic/internal/subsonic"
	"simplemusic/webui"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	fixedURL := ""
	if cfg.NavidromeURL != "" {
		if fixedURL, err = subsonic.NormalizeURL(cfg.NavidromeURL); err != nil {
			log.Fatalf("Navidrome 地址无效: %v", err)
		}
	}
	nd := subsonic.NewClient()
	sess, err := auth.NewManager(cfg.Secret, 30*24*time.Hour)
	if err != nil {
		log.Fatal(err)
	}
	streams, err := media.NewStreamCache(filepath.Join(cfg.DataDir, "audio"), cfg.CacheMaxMB, cfg.MaxBitRate, nd)
	if err != nil {
		log.Fatal(err)
	}
	images, err := media.NewImages(filepath.Join(cfg.DataDir, "covers"), nd)
	if err != nil {
		log.Fatal(err)
	}

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           api.New(nd, fixedURL, sess, streams, images).Handler(webui.Handler()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	server := fixedURL
	if server == "" {
		server = "未指定（各浏览器在页面中自行填写）"
	}
	log.Printf("简单听（simpleMusic）已启动：%s，Navidrome：%s，转码码率上限 %d kbps", cfg.Listen, server, cfg.MaxBitRate)
	log.Fatal(srv.ListenAndServe())
}
