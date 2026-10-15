package cache

import (
	"strings"
	"sync"
	"time"
)

type entry struct {
	val []byte
	exp time.Time
}

// TTL 是带过期时间的内存缓存，用来缓存 Navidrome 的列表和详情响应。
// 条目数超过上限时先清过期项，仍然超出就整体清空，换取实现简单。
type TTL struct {
	mu    sync.Mutex
	items map[string]entry
	max   int
}

func New(max int) *TTL {
	return &TTL{items: make(map[string]entry), max: max}
}

func (c *TTL) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(e.exp) {
		delete(c.items, key)
		return nil, false
	}
	return e.val, true
}

func (c *TTL) Set(key string, val []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.items) >= c.max {
		now := time.Now()
		for k, e := range c.items {
			if now.After(e.exp) {
				delete(c.items, k)
			}
		}
		if len(c.items) >= c.max {
			c.items = make(map[string]entry)
		}
	}
	c.items[key] = entry{val: val, exp: time.Now().Add(ttl)}
}

func (c *TTL) DeletePrefix(prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.items {
		if strings.HasPrefix(k, prefix) {
			delete(c.items, k)
		}
	}
}
