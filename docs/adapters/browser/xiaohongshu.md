# Xiaohongshu (小红书)

**Mode**: 🔐 Browser · **Domain**: `xiaohongshu.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli xiaohongshu search` | Search notes by keyword (returns title, author, likes, URL); `--type user` searches accounts instead |
| `opencli xiaohongshu ask` | Ask 点点 and return its answer with citation sources (`sources[]` in JSON) |
| `opencli xiaohongshu note` | Read full note content (title, author, description, likes, collects, comments, tags) |
| `opencli xiaohongshu comments` | Read comments from a note (`--with-replies` for nested 楼中楼 replies) |
| `opencli xiaohongshu feed` | Home feed recommendations (reads the hydrated Pinia store; URLs carry `xsec_token` for drill-down) |
| `opencli xiaohongshu notifications` | User notifications (mentions, likes, connections) |
| `opencli xiaohongshu user` | Get public notes from a user profile |
| `opencli xiaohongshu user-info` | Profile card for one user (nickname, red_id, desc, fans, follows, likes_collects, avatar, follow status) |
| `opencli xiaohongshu user-following` | Accounts the logged-in user follows; other users' lists are not exposed by the web app (see notes) |
| `opencli xiaohongshu saved` | List saved/collected notes (`/user/profile/<id>?tab=fav&subTab=note`) |
| `opencli xiaohongshu liked` | List liked notes (`/user/profile/<id>?tab=liked&subTab=note`) |
| `opencli xiaohongshu download` | Download images and videos from a note |
| `opencli xiaohongshu publish` | Publish image-text notes (creator center UI automation) |
| `opencli xiaohongshu delete-note` | Verify or delete a published creator-center note by exact note ID |
| `opencli xiaohongshu follow` | Follow a user through the page's own `user` store action and verify the relation after reload |
| `opencli xiaohongshu unfollow` | Unfollow a user from the profile UI, confirm the modal, and verify the button state flips |
| `opencli xiaohongshu creator-notes` | Creator's note list with per-note metrics |
| `opencli xiaohongshu creator-note-detail` | Detailed analytics for a single creator note |
| `opencli xiaohongshu creator-notes-summary` | Combined note list + detail analytics summary |
| `opencli xiaohongshu creator-profile` | Creator account info (followers, growth level) |
| `opencli xiaohongshu creator-stats` | Creator data overview (views, likes, collects, trends) |

## Usage Examples

```bash
# Search for notes
opencli xiaohongshu search 美食 --limit 10

# Combine visible search-panel filters
opencli xiaohongshu search 美食 --sort latest --note-type video --publish-time week

# Ask 点点 and keep the citation audit trail
opencli xiaohongshu ask "上海露营需要注意什么？" -f json

# Read a note's full content (pass URL from search results to preserve xsec_token)
opencli xiaohongshu note "https://www.xiaohongshu.com/search_result/<id>?xsec_token=..."

# Read comments with nested replies (楼中楼)
opencli xiaohongshu comments "https://www.xiaohongshu.com/search_result/<id>?xsec_token=..." --with-replies --limit 20

# JSON output
opencli xiaohongshu search 旅行 -f json

# Other commands
opencli xiaohongshu feed
opencli xiaohongshu saved --limit 20
opencli xiaohongshu liked --limit 20
opencli xiaohongshu saved "https://www.xiaohongshu.com/user/profile/<id>?tab=fav&subTab=note"
opencli xiaohongshu liked "https://www.xiaohongshu.com/user/profile/<id>?tab=liked&subTab=note"
opencli xiaohongshu notifications
opencli xiaohongshu download "https://www.xiaohongshu.com/search_result/<id>?xsec_token=..."
opencli xiaohongshu download "https://xhslink.com/..."

# Publish an ordinary image-text note
opencli xiaohongshu publish "正文内容" --title "标题" --images ./a.jpg,./b.png

# Publish a text-image note; split multiple cards with ||| and use \n for card line breaks
opencli xiaohongshu publish "正文内容" --title "标题" --card-text "第一张\\n第二行|||第二张" --card-style 边框

# Follow / unfollow a profile
opencli xiaohongshu follow 5d8f88dc0000000001005d3a
opencli xiaohongshu unfollow https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a

# Verify a published creator note without deleting it (default dry-run)
opencli xiaohongshu delete-note 6a08ba0b000000000702a893

# Actually delete after the target row and delete action are verified
opencli xiaohongshu delete-note 6a08ba0b000000000702a893 --execute
```

`search` supports the same visible filter-panel choices as the website: `--sort comprehensive|latest|most-liked|most-commented|most-collected`, `--note-type all|video|image`, `--publish-time anytime|day|week|half-year`, `--scope all|seen|unseen|following`, and `--location all|same-city|nearby`. Account-scoped and location filters fail explicitly when the logged-in browser session lacks the required account or geolocation capability.

> Note: `note` and `comments` now require a full signed note URL with `xsec_token`. `download` accepts either a signed note URL or an `xhslink` short link. Bare note IDs are no longer reliable on xiaohongshu.
> With `comments --with-replies`, `reply_to` is the direct reply target displayed by the page. Replies without an explicit `回复 <name>` marker target the enclosing top-level comment.
> `ask` is separate from ordinary `search`: it submits the question to 点点, returns `answer`, `source_count`, and `sources[]`, and keeps `xsec_token` in JSON when Xiaohongshu returns one. The current 点点 source API may return bare note IDs without `xsec_token`; in that case `url` falls back to `/explore/<note_id>` and `xsec_token` is an empty string. Each source also carries the engagement and identity metadata 点点 returns: `like_count`, `note_type` (`normal`/`video`), `user_id`, and `published_at` (each omitted when 点点 does not provide it), so citation analysis can read likes and note format without a follow-up `search`/`note` round-trip.
> `delete-note` operates in creator center and accepts a 24-character note ID or exact Xiaohongshu note URL; it defaults to dry-run verification and only deletes with `--execute`.
> `follow` and `unfollow` are write commands on the public profile page. Both verify the browser stayed on the requested `/user/profile/<id>` target first. `follow` no longer clicks the button (the click was intercepted by a modal in practice); it calls the Pinia `user` store's `toFollow` action — the same code path the site's own button uses, so the signed `X-s`/`X-t`/`X-S-Common` headers are produced by the page. An account you already follow returns `{ ok: true, already_following: true }` without issuing a write. `unfollow` still drives the UI and confirms the modal.
> `follow` reads the resulting relation from the follow API's own response. When that response carries no `fstatus`, it re-reads the profile — bouncing through `/explore` first, because `goto` to the same URL is a soft navigation here and leaves the pre-follow `userPageData` in place. If the read-back is still inconclusive the command **still reports success** (`ok: true`, `status: "followed-unverified"`, `verified: false`) and prints `FOLLOW_UNVERIFIED` on stderr: the write was accepted, and since the command is not idempotent, reporting a landed follow as a failure would make callers retry and follow twice. Check the profile in the browser when you see that marker.
> `search --type user`, `user-info` and `user-following` cover the account-discovery path. `search --type user` drives the search page's `search` store (`getUserLists` / `loadMoreUsers`, the "用户" tab) and returns `user_id`, `nickname`, `red_id`, `avatar`, `desc`, `fans`, `notes_count`, `followed`, `url`; counts are numbers, unknown values are `null` (the user-search API carries no bio, so `desc` is usually `null`). `user-info` reads the server-rendered profile store: `fans` / `follows` / `likes_collects` are numbers, `following` is a boolean derived from `follow_status` (`none|follows|fans|both`), and `notes_count` is `null` because the web profile does not expose it.
> `user-following` only works for the logged-in account (no argument, or your own id): the web app has no endpoint for other users' following lists — the profile's "关注 N" counter is plain text — so passing another user id exits 0 with an empty array and prints `PRIVATE_FOLLOWING` on stderr, the shared "hidden list, skip without retry" contract also used by `bilibili following` and `twitter following` / `followers`. The own-list rows come from the IM widget's `/api/im/web/users/following/all` response, which carries `user_id`, `nickname` and `avatar` only (`desc` and `fans` are `null`).
> `publish --card-text` uses creator-center 文字配图. It requires generated card images to appear in the current composer before filling title/body or submitting. If you request `--card-style`, that exact live page style must be selected; unavailable styles fail instead of silently falling back.

## Prerequisites

- Chrome running and **logged into** xiaohongshu.com
- [Browser Bridge extension](/guide/browser-bridge) installed
