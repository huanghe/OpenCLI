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
| `opencli youtube channel-videos` | A channel's uploads as a video table (`video_id`, `title`, `duration`, `views`, `views_count`, `published`, `url`, `channel_id`) |
| `opencli youtube playlist` | Get playlist video list |
| `opencli youtube feed` | Homepage recommended videos |
| `opencli youtube history` | Watch history |
| `opencli youtube watch-later` | Watch Later queue |
| `opencli youtube subscriptions` | List subscribed channels |
| `opencli youtube like` | Like a video |
| `opencli youtube unlike` | Remove like from a video |
| `opencli youtube subscribe` | Subscribe to a channel |
| `opencli youtube unsubscribe` | Unsubscribe from a channel |

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
```

## Prerequisites

- Chrome running and **logged into** youtube.com
- [Browser Bridge extension](/guide/browser-bridge) installed

## Notes

- `feed` and `search` emit `channel_avatar` (largest thumbnail the list page carries) and `video_id`; both are empty for result types that have no channel avatar or video, such as playlist lockups
- `channel` adds `channel_id` (snake_case twin of `channelId`), `subscribers_count` and `video_count` as numbers parsed from the header text (`"1.2M subscribers"` / `"2120万位订阅者"` → `21200000`); `null` when the header has no such text
- `search --type channel` rows add `channel_id`, `handle`, `subscribers` (display text), `subscribers_count`, `video_count` and `description`, so callers no longer have to reverse the handle out of `url` before calling `channel`
- `channel-videos <id|@handle|url>` follows InnerTube continuation tokens up to `--limit` (max 200)
- `video` falls back to the channel's own browse response for `channel_avatar` / `subscribers` when the watch page ships no `videoOwnerRenderer` — one extra InnerTube call, only on the pages that need it
