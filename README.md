# Tab Atelier for Chrome

Organize open tabs by domain, save YouTube videos to a local Inbox, and reopen videos in groups when you are ready to watch.

[Download the latest release](https://github.com/fbn90/tab-atelier-chrome/releases/latest)

## Features

- Group open tabs by website, YouTube channel or topic.
- Save videos before closing tabs, then search and review them in the Video Inbox.
- Open ten, twenty or all matching videos in a group. The opt-in tab protection can archive older videos and protect explicitly approved groups.
- Import or export an Inbox backup as JSON.

## Install

1. Download the extension ZIP from Releases and extract it to a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`. Pin the extension if you want its popup in the toolbar.

For an update, keep the same local extension directory so Chrome retains the extension ID and its local settings. Back up your Inbox before changing installations.

## Screenshot

![Tab Atelier for Chrome with sample data](docs/screenshot.png)

## Privacy

Browser tab details and Inbox backups stay on your device. Optional metadata lookup contacts YouTube without cookies.

## Development

Run the JavaScript checks with `npm test`.

## License

[MIT](LICENSE).
