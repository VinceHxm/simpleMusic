package media

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"simplemusic/internal/subsonic"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// fileKey 带上服务器地址的摘要：不同浏览器可能连着不同的 Navidrome，同一个 ID 可能是不同的歌。
func fileKey(server, id string) string {
	ss := md5.Sum([]byte(server))
	prefix := hex.EncodeToString(ss[:4]) + "_"
	if safeID.MatchString(id) {
		return prefix + id
	}
	sum := md5.Sum([]byte(id))
	return prefix + hex.EncodeToString(sum[:])
}

// StreamCache 把 Navidrome 转码出的 MP3 完整落盘后再提供给浏览器。
// 转码流本身不支持 Range，旧版 iOS Safari 依赖 Range 才能正常播放和拖动进度。
type StreamCache struct {
	dir      string
	maxBytes int64
	bitRate  int
	client   *subsonic.Client
	group    singleflight.Group
	cleanMu  sync.Mutex
}

func NewStreamCache(dir string, maxMB int64, bitRate int, client *subsonic.Client) (*StreamCache, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &StreamCache{dir: dir, maxBytes: maxMB << 20, bitRate: bitRate, client: client}, nil
}

func (s *StreamCache) path(server, id string) string {
	return filepath.Join(s.dir, fileKey(server, id)+"_"+strconv.Itoa(s.bitRate)+".mp3")
}

// Ensure 返回缓存文件路径，不存在时下载；同一首歌的并发请求只会触发一次转码。
func (s *StreamCache) Ensure(a subsonic.Auth, id string) (string, error) {
	p := s.path(a.Server, id)
	if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
		now := time.Now()
		_ = os.Chtimes(p, now, now)
		return p, nil
	}
	_, err, _ := s.group.Do(p, func() (any, error) {
		return nil, s.download(a, id, p)
	})
	if err != nil {
		return "", err
	}
	return p, nil
}

func (s *StreamCache) download(a subsonic.Auth, id, dst string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	q := url.Values{}
	q.Set("id", id)
	q.Set("format", "mp3")
	q.Set("maxBitRate", strconv.Itoa(s.bitRate))
	resp, err := s.client.Fetch(ctx, a, "stream", q)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	tmp := dst + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	go s.cleanup()
	return nil
}

func (s *StreamCache) cleanup() {
	s.cleanMu.Lock()
	defer s.cleanMu.Unlock()

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	var items []item
	var total int64
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".mp3" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, item{filepath.Join(s.dir, e.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	if total <= s.maxBytes {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	target := s.maxBytes * 9 / 10
	for _, it := range items {
		if total <= target {
			break
		}
		if err := os.Remove(it.path); err == nil {
			total -= it.size
		}
	}
	log.Printf("音频缓存清理完成，当前占用 %d MB", total>>20)
}
