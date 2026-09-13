# YouTube

**Mode**: 🔐 Browser · **Domain**: `youtube.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli youtube search` | Search videos |
| `opencli youtube video` | Get video metadata |
| `opencli youtube transcript` | Get video transcript/subtitles |
| `opencli youtube comments` | Get video comments |
| `opencli youtube channel` | Get channel info and videos |
| `opencli youtube playlist` | Get playlist video list |
| `opencli youtube feed` | Homepage recommended videos |
| `opencli youtube history` | Watch history |
| `opencli youtube watch-later` | Watch Later queue |
| `opencli youtube subscriptions` | List subscribed channels |
| `opencli youtube like` | Like a video |
| `opencli youtube unlike` | Remove like from a video |
| `opencli youtube subscribe` | Subscribe to a channel |
| `opencli youtube unsubscribe` | Unsubscribe from a channel |
| `opencli youtube comment` | Post a top-level comment on a video (requires `--execute`) |

## Usage Examples

```bash
# Read commands
opencli youtube feed --limit 10
opencli youtube history --limit 20
opencli youtube watch-later --limit 50
opencli youtube subscriptions --limit 30

# Search and video info
opencli youtube search "rust programming" --limit 5
opencli youtube video "https://www.youtube.com/watch?v=xxx"
opencli youtube transcript "https://www.youtube.com/watch?v=xxx"

# Write commands (requires login)
opencli youtube like "https://www.youtube.com/watch?v=xxx"
opencli youtube unlike "videoId"
opencli youtube subscribe "@ChannelHandle"
opencli youtube unsubscribe "UCxxxxxxxxxxxxxx"
opencli youtube comment "https://www.youtube.com/watch?v=xxx" "Great video!" --execute
```

> Note: `youtube comment` refuses to post unless `--execute` is passed, and never retries. When
> YouTube accepts the write but returns no comment id, the row is still `status: posted-unverified`
> with `verified: false` and a `COMMENT_UNVERIFIED` line on stderr — treat that as "sent, go check the
> video", not as a failure to retry. On success `url` is the comment permalink (`watch?v=<id>&lc=<comment_id>`).

## Prerequisites

- Chrome running and **logged into** youtube.com
- [Browser Bridge extension](/guide/browser-bridge) installed
