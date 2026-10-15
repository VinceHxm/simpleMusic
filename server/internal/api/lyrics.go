package api

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"simplemusic/internal/subsonic"
)

const lyricsTTL = 30 * time.Minute

// LyricLine 的 Time 单位为毫秒；不带时间轴的歌词没有 Time。
// 同一时间点的多行（常见于中外双语 LRC）合并为一行，第二行起放进 Trans。
type LyricLine struct {
	Time  *int   `json:"time,omitempty"`
	Text  string `json:"text"`
	Trans string `json:"trans,omitempty"`
}

type Lyrics struct {
	Synced bool        `json:"synced"`
	Lines  []LyricLine `json:"lines"`
}

type structuredLyrics struct {
	Offset int  `json:"offset"`
	Synced bool `json:"synced"`
	Line   []struct {
		Start *int   `json:"start"`
		Value string `json:"value"`
	} `json:"line"`
}

func (s *Server) lyrics(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	res, err := s.lyricsBySongID(r, a, r.PathValue("id"))
	if err == nil && len(res.Lines) == 0 {
		res, err = s.lyricsByName(r, a, r.URL.Query().Get("artist"), r.URL.Query().Get("title"))
	}
	if err != nil {
		var se *subsonic.Error
		if errors.As(err, &se) && se.Code == subsonic.ErrCodeAuth {
			s.fail(w, r, err)
			return
		}
		// 歌词只是附加信息，Navidrome 不支持或查不到时按“没有歌词”处理，不影响播放页。
		res = Lyrics{}
	}
	if res.Lines == nil {
		res.Lines = []LyricLine{}
	}
	writeJSON(w, r, http.StatusOK, res)
}

// lyricsBySongID 使用 OpenSubsonic 的 songLyrics 扩展，能拿到带时间轴的歌词；
// 服务端不支持该扩展时返回错误，由调用方回退到 getLyrics。
func (s *Server) lyricsBySongID(r *http.Request, a subsonic.Auth, id string) (Lyrics, error) {
	var out struct {
		LyricsList struct {
			StructuredLyrics []structuredLyrics `json:"structuredLyrics"`
		} `json:"lyricsList"`
	}
	if err := s.cached(r.Context(), a, "getLyricsBySongId", url.Values{"id": {id}}, lyricsTTL, &out); err != nil {
		var se *subsonic.Error
		if errors.As(err, &se) && se.Code != subsonic.ErrCodeAuth {
			return Lyrics{}, nil
		}
		return Lyrics{}, err
	}
	list := out.LyricsList.StructuredLyrics
	if len(list) == 0 {
		return Lyrics{}, nil
	}
	pick := list[0]
	for _, l := range list {
		if l.Synced && len(l.Line) > 0 {
			pick = l
			break
		}
	}
	lines := make([]LyricLine, 0, len(pick.Line))
	for _, l := range pick.Line {
		line := LyricLine{Text: strings.TrimSpace(l.Value)}
		if pick.Synced && l.Start != nil {
			// LRC 的 offset 为正表示歌词整体提前显示。
			t := max(*l.Start-pick.Offset, 0)
			line.Time = &t
		}
		lines = append(lines, line)
	}
	return normalize(lines, pick.Synced), nil
}

func (s *Server) lyricsByName(r *http.Request, a subsonic.Auth, artist, title string) (Lyrics, error) {
	artist, title = strings.TrimSpace(artist), strings.TrimSpace(title)
	if title == "" {
		return Lyrics{}, nil
	}
	q := url.Values{}
	q.Set("title", title)
	if artist != "" {
		q.Set("artist", artist)
	}
	var out struct {
		Lyrics struct {
			Value string `json:"value"`
		} `json:"lyrics"`
	}
	if err := s.cached(r.Context(), a, "getLyrics", q, lyricsTTL, &out); err != nil {
		return Lyrics{}, err
	}
	return parseLRC(out.Lyrics.Value), nil
}

var (
	lrcTimeTag   = regexp.MustCompile(`\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]`)
	lrcOffsetTag = regexp.MustCompile(`(?i)^\[offset:\s*([+-]?\d+)\s*\]`)
	lrcMetaTag   = regexp.MustCompile(`^\[[a-zA-Z]+:[^\]]*\]$`)
)

// parseLRC 解析 getLyrics 返回的文本：带 [mm:ss.xx] 时间标签的按 LRC 处理，否则按纯文本逐行展示。
func parseLRC(text string) Lyrics {
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	raw := strings.Split(text, "\n")
	offset := 0
	var timed []LyricLine
	for _, l := range raw {
		l = strings.TrimSpace(l)
		if m := lrcOffsetTag.FindStringSubmatch(l); m != nil {
			offset, _ = strconv.Atoi(m[1])
			continue
		}
		tags := lrcTimeTag.FindAllStringSubmatchIndex(l, -1)
		if len(tags) == 0 || tags[0][0] != 0 {
			continue
		}
		end := 0
		var times []int
		for _, tg := range tags {
			if tg[0] != end {
				break
			}
			end = tg[1]
			mm, _ := strconv.Atoi(l[tg[2]:tg[3]])
			ss, _ := strconv.Atoi(l[tg[4]:tg[5]])
			ms := 0
			if tg[6] >= 0 {
				frac := l[tg[6]:tg[7]]
				ms, _ = strconv.Atoi(frac)
				for i := len(frac); i < 3; i++ {
					ms *= 10
				}
			}
			times = append(times, (mm*60+ss)*1000+ms)
		}
		body := strings.TrimSpace(l[end:])
		for _, t := range times {
			t := t
			timed = append(timed, LyricLine{Time: &t, Text: body})
		}
	}
	if len(timed) > 0 {
		sort.SliceStable(timed, func(i, j int) bool { return *timed[i].Time < *timed[j].Time })
		for i := range timed {
			t := max(*timed[i].Time-offset, 0)
			timed[i].Time = &t
		}
		return normalize(timed, true)
	}
	var plain []LyricLine
	for _, l := range raw {
		l = strings.TrimSpace(l)
		if lrcMetaTag.MatchString(l) {
			continue
		}
		plain = append(plain, LyricLine{Text: l})
	}
	return normalize(plain, false)
}

// normalize 合并同一时间点的多行，并去掉首尾空行；全部为空时视为没有歌词。
func normalize(lines []LyricLine, synced bool) Lyrics {
	var out []LyricLine
	for _, l := range lines {
		if synced && len(out) > 0 && l.Time != nil && out[len(out)-1].Time != nil && *out[len(out)-1].Time == *l.Time {
			prev := &out[len(out)-1]
			switch {
			case l.Text == "":
			case prev.Text == "":
				prev.Text = l.Text
			case prev.Trans == "":
				prev.Trans = l.Text
			default:
				prev.Trans += "\n" + l.Text
			}
			continue
		}
		out = append(out, l)
	}
	for len(out) > 0 && out[0].Text == "" {
		out = out[1:]
	}
	for len(out) > 0 && out[len(out)-1].Text == "" {
		out = out[:len(out)-1]
	}
	if len(out) == 0 {
		return Lyrics{Lines: []LyricLine{}}
	}
	return Lyrics{Synced: synced, Lines: out}
}
