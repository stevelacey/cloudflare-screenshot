Cloudflare Screenshot
=====================

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
| https://steve.ly/screenshots/home.png?dark=on | https://steve.ly/home?dark=on |

For social media cards you might want to render a template that works well on social media:

| 🖼 PNG (Cloudflare request) | 📄 HTML (webserver request) |
| :-- | :-- |
| https://coworkations.com/screenshots/cards/hacker-paradise.png | https://coworkations.com/cards/hacker-paradise |
| https://coworkations.com/screenshots/cards/pack/ubud-bali-2.png | https://coworkations.com/cards/pack/ubud-bali-2 |

The default dimensions for screenshots are 1280x720, which works well for most social media cards. You can specify different dimensions via the URL, e.g., `screenshots/1024x768/path/to/something.png`.

Additionally, you can adjust the pixel density by appending `@2x`, `@3x`, or `@4x` to the filename, e.g., `screenshots/path/to/something@2x.png`.

If you want to configure some query params to always pass through to your backend, you can set the `QUERY_PARAMS` environment variable and they will be appended to every webserver request.


Markup
------

You’ll probably want meta tags something like these:

```html
<meta itemprop="image" content="https://coworkations.com/screenshots/cards/coworkations.png">
<meta property="og:image" content="https://coworkations.com/screenshots/cards/coworkations.png">
<meta name="twitter:image" content="https://coworkations.com/screenshots/cards/coworkations.png">
```


Debugging
---------

- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug)
- [Twitter Card Validator](https://cards-dev.twitter.com/validator)
