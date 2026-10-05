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

Videos are recorded by requesting `.mp4`, `.webp` or `.gif` instead, e.g., `screenshots/path/to/something.mp4`. They run for 5 seconds by default, and you can choose anywhere from 1 to 30 seconds via the URL, after any dimensions, e.g., `screenshots/1200x630/20s/path/to/something.mp4`. Recording starts once the page has loaded, so loop any animations you want to capture or delay their start. MP4s are H.264 at 30fps. Animated WebPs are 15fps, for animated previews like YouTube's, and GIFs are 10fps; both are much larger, so you may want to keep them small, e.g., `screenshots/320x180/3s/path/to/something.webp`.

If you want to configure some query params to always pass through to your backend, you can set the `QUERY_PARAMS` environment variable and they will be appended to every webserver request.


Markup
------

You’ll probably want meta tags something like these:

```html
<meta itemprop="image" content="https://coworkations.com/screenshots/cards/coworkations.png">
<meta property="og:image" content="https://coworkations.com/screenshots/cards/coworkations.png">
<meta name="twitter:image" content="https://coworkations.com/screenshots/cards/coworkations.png">
```

And for a video card:

```html
<meta property="og:video" content="https://steve.ly/screenshots/home.mp4?dark=on">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1280">
<meta property="og:video:height" content="720">
```


Debugging
---------

- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug)
- [Twitter Card Validator](https://cards-dev.twitter.com/validator)
