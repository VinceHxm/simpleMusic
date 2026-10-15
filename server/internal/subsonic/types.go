package subsonic

// 这些结构体只保留播放器需要的字段，既用于解码 Navidrome 响应，也直接作为前端接口的输出。

type Song struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Album      string `json:"album,omitempty"`
	AlbumID    string `json:"albumId,omitempty"`
	Artist     string `json:"artist,omitempty"`
	ArtistID   string `json:"artistId,omitempty"`
	Track      int    `json:"track,omitempty"`
	DiscNumber int    `json:"discNumber,omitempty"`
	Year       int    `json:"year,omitempty"`
	Duration   int    `json:"duration,omitempty"`
	CoverArt   string `json:"coverArt,omitempty"`
	Starred    string `json:"starred,omitempty"`
}

type Album struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Artist    string `json:"artist,omitempty"`
	ArtistID  string `json:"artistId,omitempty"`
	CoverArt  string `json:"coverArt,omitempty"`
	SongCount int    `json:"songCount,omitempty"`
	Duration  int    `json:"duration,omitempty"`
	Year      int    `json:"year,omitempty"`
	Starred   string `json:"starred,omitempty"`
	Song      []Song `json:"song,omitempty"`
}

type Artist struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	CoverArt   string  `json:"coverArt,omitempty"`
	AlbumCount int     `json:"albumCount,omitempty"`
	Starred    string  `json:"starred,omitempty"`
	Album      []Album `json:"album,omitempty"`
}

type ArtistIndex struct {
	Name   string   `json:"name"`
	Artist []Artist `json:"artist"`
}

type Playlist struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Comment   string `json:"comment,omitempty"`
	Owner     string `json:"owner,omitempty"`
	SongCount int    `json:"songCount"`
	Duration  int    `json:"duration,omitempty"`
	CoverArt  string `json:"coverArt,omitempty"`
	Entry     []Song `json:"entry,omitempty"`
}

type User struct {
	Username  string `json:"username"`
	AdminRole bool   `json:"adminRole"`
}

type SearchResult struct {
	Artist []Artist `json:"artist"`
	Album  []Album  `json:"album"`
	Song   []Song   `json:"song"`
}
