Cloudflare Screenshot
=====================

[![CI](https://img.shields.io/github/actions/workflow/status/stevelacey/cloudflare-screenshot/ci.yml?branch=main&style=flat-square)](https://github.com/stevelacey/cloudflare-screenshot/actions/workflows/ci.yml?query=branch:main)
[![Coverage](https://img.shields.io/codecov/c/github/stevelacey/cloudflare-screenshot?style=flat-square)](https://codecov.io/gh/stevelacey/cloudflare-screenshot)
[![License: MIT](https://img.shields.io/github/license/stevelacey/cloudflare-screenshot?style=flat-square)](LICENSE.md)

Screenshot webpages to render social media cards on-the-fly using Puppeteer; largely based on [how Pieter generates shareable pictures](https://levels.io/phantomjs-social-media-share-pictures) for [Nomad List](https://nomadlist.com).

| [![Coworkations](https://coworkations.com/screenshots/cards/coworkations.png)](https://coworkations.com/screenshots/cards/coworkations.png) [📄 HTML](https://coworkations.com/cards/coworkations) [🖼️ PNG](https://coworkations.com/screenshots/cards/coworkations.png) | [![Hacker Paradise: Cape Town South Africa](https://coworkations.com/screenshots/cards/hacker-paradise/cape-town-south-africa.png)](https://coworkations.com/screenshots/cards/hacker-paradise/cape-town-south-africa.png) [📄 HTML](https://coworkations.com/cards/hacker-paradise/cape-town-south-africa) [🖼️ PNG](https://coworkations.com/screenshots/cards/hacker-paradise/cape-town-south-africa.png) |
| --: | --: |
| **[![Nomad Cruise VI: Spain To Greece](https://coworkations.com/screenshots/cards/nomad-cruise/nomad-cruise-13-canada-to-japan-sep-2024.png)](https://coworkations.com/screenshots/cards/nomad-cruise/nomad-cruise-13-canada-to-japan-sep-2024.png) [📄 HTML](https://coworkations.com/cards/nomad-cruise/nomad-cruise-13-canada-to-japan-sep-2024) [🖼️ PNG](https://coworkations.com/screenshots/cards/nomad-cruise/nomad-cruise-13-canada-to-japan-sep-2024.png)** | **[![PACK: Ubud Bali](https://coworkations.com/screenshots/cards/pack/ubud-bali-2.png)](https://coworkations.com/screenshots/cards/pack/ubud-bali-2.png) [📄 HTML](https://coworkations.com/cards/pack/ubud-bali-2) [🖼️ PNG](https://coworkations.com/screenshots/cards/pack/ubud-bali-2.png)** |


Setup
-----

Deploy the worker to Cloudflare and mount it on a route like `example.com/screenshots/*`, then visit `screenshots/path/to/something.png` for a capture of `path/to/something`.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/stevelacey/cloudflare-screenshot)


Usage
-----

Screenshots can be of any webpage, you can pass query params through to your backend if you need to toggle behaviors like to force dark mode on/off, or disable things like Intercom:

| 🖼 PNG (Cloudflare request) | 📄 HTML (webserver request) |
| :-- | :-- |
| https://coworkations.com/screenshots/hacker-paradise.png | https://coworkations.com/hacker-paradise |
| https://steve.ly/screenshots/home.png?dark=on | https://steve.ly/?dark=on |

For social media cards you might want to render a template that works well on social media:

| 🖼 PNG (Cloudflare request) | 📄 HTML (webserver request) |
| :-- | :-- |
| https://coworkations.com/screenshots/cards/hacker-paradise.png | https://coworkations.com/cards/hacker-paradise |
| https://coworkations.com/screenshots/cards/pack/ubud-bali-2.png | https://coworkations.com/cards/pack/ubud-bali-2 |

The default dimensions for screenshots are 1280x720, which works well for most social media cards. You can specify different dimensions via the URL, e.g., `screenshots/1024x768/path/to/something.png`.

To screenshot your homepage, request `home.png`, which captures `/`, e.g., `screenshots/home.png?dark=on` captures `/?dark=on`.

Additionally, you can adjust the pixel density by appending `@2x`, `@3x`, or `@4x` to the filename, e.g., `screenshots/path/to/something@2x.png`.


Environment variables
---------------------

| Variable | Example | |
| :-- | :-- | :-- |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | | A Cloudflare Access service token, to screenshot a site behind Access |
| `QUERY_PARAMS` | `dark=on` | Query params appended to every webserver request, to toggle behaviors for screenshots |
| `EXTERNAL_DOMAINS` | `example.org,news.example.net` | Other sites to allow, requested like `screenshots/example.org/some/page.png`; they're never sent `QUERY_PARAMS` or your Cloudflare Access credentials |


Markup
------

You’ll probably want meta tags something like these:

```html
<meta itemprop="image" content="https://coworkations.com/screenshots/cards/coworkations.png">
<meta property="og:image" content="https://coworkations.com/screenshots/cards/coworkations.png">
<meta name="twitter:image" content="https://coworkations.com/screenshots/cards/coworkations.png">
```


Videos
------

Request `.mp4`, `.webp` or `.gif` to record the page, e.g., `screenshots/path/to/something.mp4`. Recording starts once the page has loaded, so loop any animations you want to capture. MP4s are H.264; animated WebPs and GIFs are much larger, so keep those small.

Append a resolution to the filename to set the video's size, from `@240p`, `@360p`, `@480p`, `@720p`, `@1080p`, `@1440p` or `@4k`, e.g., `screenshots/path/to/something@480p.mp4`. The page is laid out at its usual size and the width follows its shape, so `@480p` of a 1280x720 page is 854x480.

Options go after any dimensions, separated by commas, e.g., `screenshots/1024x768/duration=10s,scroll=features;pricing/path/to/something.mp4`:

| Option | Example | Default | |
| :-- | :-- | :-- | :-- |
| `duration` | `duration=10s` | `5s` | How long to record, up to 30 seconds |
| `fps` | `fps=8` | `30` for MP4, `15` for WebP, `10` for GIF | Frames per second, up to 30; fewer record faster and make smaller files |
| `quality` | `quality=60` | `80` | From 1 to 100, for MP4 and WebP |
| `scroll` | `scroll=features;pricing` | None | Element ids or positions like `2000px` to scroll to in turn, pausing at the top and at each one |
| `start` | `start=1m15s` | `0s` | Where to start a YouTube video |

Scrolling to an element respects its `scroll-margin-top`, and positions are from the top, so `scroll=2000px;0px` scrolls down and back up.

| [![Travels](https://steve.ly/screenshots/travels@480p.webp?dark=on)](https://steve.ly/screenshots/travels@480p.mp4?dark=on) [📄 HTML](https://steve.ly/travels?dark=on) [🎬 MP4](https://steve.ly/screenshots/travels@480p.mp4?dark=on) [🖼️ WebP](https://steve.ly/screenshots/travels@480p.webp?dark=on) | [![Travels](https://steve.ly/screenshots/duration=10s,quality=50/travels@480p.webp?dark=on)](https://steve.ly/screenshots/duration=10s/travels@480p.mp4?dark=on) [📄 HTML](https://steve.ly/travels?dark=on) [🎬 MP4](https://steve.ly/screenshots/duration=10s/travels@480p.mp4?dark=on) [🖼️ WebP](https://steve.ly/screenshots/duration=10s/travels@480p.webp?dark=on) | [![Travels](https://steve.ly/screenshots/duration=10s,quality=50,scroll=2026;2025;2024/travels@480p.webp?dark=on)](https://steve.ly/screenshots/duration=10s,scroll=2026;2025;2024/travels@480p.mp4?dark=on) [📄 HTML](https://steve.ly/travels?dark=on) [🎬 MP4](https://steve.ly/screenshots/duration=10s,scroll=2026;2025;2024/travels@480p.mp4?dark=on) [🖼️ WebP](https://steve.ly/screenshots/duration=10s,scroll=2026;2025;2024/travels@480p.webp?dark=on) |
| --: | --: | --: |

YouTube videos can be recorded by their ID, without YouTube's player around them, e.g., `screenshots/320x180/duration=3s,start=1m15s/youtube/_TcEfYlW4PA.webp`. YouTube turns away many requests from Cloudflare, so each is tried up to 20 times, and some still fail.

For a video card, add tags like these:

```html
<meta property="og:video" content="https://steve.ly/screenshots/travels@480p.mp4?dark=on">
<meta property="og:video:width" content="854">
<meta property="og:video:height" content="480">
<meta property="og:video:type" content="video/mp4">
```


Debugging
---------

- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug)
- [Twitter Card Validator](https://cards-dev.twitter.com/validator)
