package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const defaultYtDlpPath = "/opt/weebin-yt-dlp/bin/yt-dlp"

type ytDlpFormat struct {
	URL      string  `json:"url"`
	Ext      string  `json:"ext"`
	VCodec   string  `json:"vcodec"`
	ACodec   string  `json:"acodec"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	FormatID string  `json:"format_id"`
	Bitrate  float64 `json:"tbr"`
}

type ytDlpInfo struct {
	Duration float64       `json:"duration"`
	Formats  []ytDlpFormat `json:"formats"`
}

func ytDlpPath() string {
	return firstNonEmpty(os.Getenv("YT_DLP_PATH"), defaultYtDlpPath)
}

func ytDlpCookiesArgs() []string {
	candidates := []string{
		os.Getenv("YOUTUBE_COOKIES_PATH"),
		"../data/youtube-cookies.txt",
		"data/youtube-cookies.txt",
	}

	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			return []string{"--cookies", candidate}
		}
	}

	return nil
}

func fetchYtDlpItems(ctx context.Context, youtubeURL string) ([]ydwnMediaItem, error) {
	args := []string{
		"--dump-single-json",
		"--no-playlist",
		"--skip-download",
		"--no-warnings",
		"--format-sort", "res,fps,br",
	}
	args = append(args, ytDlpCookiesArgs()...)
	args = append(args, youtubeURL)
	command := exec.CommandContext(ctx, ytDlpPath(), args...)

	output, err := command.Output()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			message := strings.TrimSpace(string(exitError.Stderr))
			if message != "" {
				return nil, errors.New("yt-dlp: " + message)
			}
		}
		return nil, err
	}

	var info ytDlpInfo
	if err := json.Unmarshal(output, &info); err != nil {
		return nil, errors.New("invalid yt-dlp response")
	}

	items := make([]ydwnMediaItem, 0, 8)
	var audio *ytDlpFormat

	for _, format := range info.Formats {
		if format.URL == "" || format.Ext != "mp4" {
			continue
		}

		hasVideo := format.VCodec != "" && format.VCodec != "none"
		hasAudio := format.ACodec != "" && format.ACodec != "none"

		if hasVideo && hasAudio {
			if format.Height > 0 {
				items = append(items, ytDlpVideoItem(format, info.Duration))
			}
			continue
		}

		if hasVideo && !hasAudio && format.Height > 0 {
			items = append(items, ytDlpVideoItem(format, info.Duration))
			continue
		}

		if hasAudio && !hasVideo && (audio == nil || format.Bitrate > audio.Bitrate) {
			current := format
			audio = &current
		}
	}

	if audio != nil {
		items = append(items, ydwnMediaItem{
			Type:            "Audio",
			MediaPreviewURL: audio.URL,
			MediaQuality:    "128K",
			MediaDuration:   strconv.FormatFloat(info.Duration, 'f', 3, 64),
		})
	}

	if len(items) == 0 {
		return nil, errors.New("yt-dlp returned no playable mp4 formats")
	}

	return items, nil
}

func ytDlpVideoItem(format ytDlpFormat, duration float64) ydwnMediaItem {
	quality := "SD"
	if format.Height >= 1080 {
		quality = "FHD"
	} else if format.Height >= 720 {
		quality = "HD"
	}

	return ydwnMediaItem{
		Type:            "Video",
		MediaPreviewURL: format.URL,
		MediaRes:        strconv.Itoa(format.Width) + "x" + strconv.Itoa(format.Height),
		MediaQuality:    quality,
		MediaDuration:   strconv.FormatFloat(duration, 'f', 3, 64),
	}
}
