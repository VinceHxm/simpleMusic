package media

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	_ "image/gif"
	_ "image/png"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"golang.org/x/sync/singleflight"

	"simplemusic/internal/subsonic"
)

var coverSizes = []int{64, 150, 300, 600}

// NormalizeSize 把任意尺寸归到固定的几档，避免缓存目录被各种尺寸撑爆。
func NormalizeSize(size int) int {
	for _, s := range coverSizes {
		if size <= s {
			return s
		}
	}
	return coverSizes[len(coverSizes)-1]
}

type Images struct {
	dir    string
	client *subsonic.Client
	group  singleflight.Group
}

func NewImages(dir string, client *subsonic.Client) (*Images, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Images{dir: dir, client: client}, nil
}

func (im *Images) Cover(a subsonic.Auth, id string, size int) (string, error) {
	size = NormalizeSize(size)
	p := filepath.Join(im.dir, fileKey(a.Server, id)+"_"+strconv.Itoa(size))
	return im.cached(p, func(tmp *os.File) error {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		q := url.Values{}
		q.Set("id", id)
		q.Set("size", strconv.Itoa(size))
		resp, err := im.client.Fetch(ctx, a, "getCoverArt", q)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
		if err != nil {
			return err
		}
		// Navidrome 缩放后的封面是 WebP，iOS 14 以前的 Safari 无法显示；占位图则会忽略 size。
		// 两种情况都重新编码成指定尺寸以内的 JPEG。
		ct := http.DetectContentType(data)
		cfg, _, cfgErr := image.DecodeConfig(bytes.NewReader(data))
		oversized := cfgErr == nil && cfg.Width > size
		if !oversized && (ct == "image/jpeg" || ct == "image/png" || ct == "image/gif") {
			_, err = tmp.Write(data)
			return err
		}
		img, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return err
		}
		if oversized {
			img = scaleToWidth(img, size)
		}
		return jpeg.Encode(tmp, flatten(img), &jpeg.Options{Quality: 85})
	})
}

func scaleToWidth(img image.Image, w int) *image.RGBA {
	b := img.Bounds()
	h := max(w*b.Dy()/max(b.Dx(), 1), 1)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	return dst
}

// flatten 把带透明通道的图片铺到深色底上再转 JPEG，否则透明区域会变成纯黑。
func flatten(img image.Image) image.Image {
	b := img.Bounds()
	dst := image.NewRGBA(b)
	draw.Draw(dst, b, &image.Uniform{C: color.RGBA{0x22, 0x26, 0x31, 0xff}}, image.Point{}, draw.Src)
	draw.Draw(dst, b, img, b.Min, draw.Over)
	return dst
}

// Blur 生成一张很小的模糊封面，前端拉伸后当作播放页背景，旧设备上不需要 backdrop-filter。
func (im *Images) Blur(a subsonic.Auth, id string) (string, error) {
	p := filepath.Join(im.dir, fileKey(a.Server, id)+"_blur.jpg")
	return im.cached(p, func(tmp *os.File) error {
		src, err := im.Cover(a, id, 150)
		if err != nil {
			return err
		}
		f, err := os.Open(src)
		if err != nil {
			return err
		}
		defer f.Close()
		img, _, err := image.Decode(f)
		if err != nil {
			return err
		}
		small := scaleToWidth(img, 48)
		for i := 0; i < 3; i++ {
			boxBlur(small, 3)
		}
		return jpeg.Encode(tmp, small, &jpeg.Options{Quality: 80})
	})
}

func (im *Images) cached(p string, fill func(tmp *os.File) error) (string, error) {
	if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
		return p, nil
	}
	_, err, _ := im.group.Do(p, func() (any, error) {
		tmp, err := os.Create(p + ".tmp")
		if err != nil {
			return nil, err
		}
		if err := fill(tmp); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return nil, err
		}
		if err := tmp.Close(); err != nil {
			os.Remove(tmp.Name())
			return nil, err
		}
		return nil, os.Rename(tmp.Name(), p)
	})
	if err != nil {
		return "", err
	}
	return p, nil
}

func boxBlur(img *image.RGBA, r int) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	tmp := image.NewRGBA(b)
	pass := func(dst, src *image.RGBA, horizontal bool) {
		outer, inner := h, w
		if !horizontal {
			outer, inner = w, h
		}
		for o := 0; o < outer; o++ {
			for i := 0; i < inner; i++ {
				var sr, sg, sb, n int
				for k := i - r; k <= i+r; k++ {
					kk := min(max(k, 0), inner-1)
					x, y := kk, o
					if !horizontal {
						x, y = o, kk
					}
					c := src.RGBAAt(x, y)
					sr += int(c.R)
					sg += int(c.G)
					sb += int(c.B)
					n++
				}
				x, y := i, o
				if !horizontal {
					x, y = o, i
				}
				dst.SetRGBA(x, y, color.RGBA{uint8(sr / n), uint8(sg / n), uint8(sb / n), 255})
			}
		}
	}
	pass(tmp, img, true)
	pass(img, tmp, false)
}
