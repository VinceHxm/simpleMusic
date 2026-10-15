package config

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Listen       string
	NavidromeURL string
	DataDir      string
	Secret       string
	MaxBitRate   int
	CacheMaxMB   int64
}

func Load() (*Config, error) {
	c := &Config{}
	flag.StringVar(&c.Listen, "listen", env("SM_LISTEN", ":8080"), "监听地址")
	flag.StringVar(&c.NavidromeURL, "navidrome", env("SM_NAVIDROME_URL", ""), "Navidrome 服务地址；留空则在页面中设置，指定后页面中不可修改")
	flag.StringVar(&c.DataDir, "data", env("SM_DATA_DIR", "./data"), "数据目录（音频缓存、封面缓存、会话密钥）")
	flag.StringVar(&c.Secret, "secret", env("SM_SECRET", ""), "会话加密密钥，留空则自动生成并保存到数据目录")
	flag.IntVar(&c.MaxBitRate, "bitrate", envInt("SM_MAX_BITRATE", 192), "转码码率上限（kbps）")
	flag.Int64Var(&c.CacheMaxMB, "cache-mb", int64(envInt("SM_CACHE_MB", 2048)), "音频缓存上限（MB）")
	flag.Parse()

	if err := os.MkdirAll(c.DataDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	if c.Secret == "" {
		secret, err := loadOrCreateSecret(filepath.Join(c.DataDir, "secret.key"))
		if err != nil {
			return nil, err
		}
		c.Secret = secret
	}
	return c, nil
}

func loadOrCreateSecret(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		return strings.TrimSpace(string(b)), nil
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(secret), 0o600); err != nil {
		return "", fmt.Errorf("保存会话密钥失败: %w", err)
	}
	return secret, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return def
}
