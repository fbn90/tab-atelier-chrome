# Tab Atelier for Chrome 3.1.21

This release tightens how Tab Atelier works with Tab Parker and makes automatic duplicate closing opt-in.

- **Automatic duplicate closing is now off by default.** Closing a tab discards its state, such as the playback position. Turn it on in the popup with **Automatically close new duplicates**. If you never changed this setting, it is now off. Manual **Clean up duplicates now** is unchanged.
- **Only a verified Tab Parker receives Inbox videos.** Tab Atelier trusts the Tab Parker ID `bhnabphdcdknjeebnmeikbdcncnfhdpf`, which Tab Parker 1.3.11 uses for both store and unpacked installations. Another extension that claims to be Tab Parker no longer receives video titles, channels and links, and its pages are never used to close tabs.
- **Connect Tab Parker.** An older Tab Parker with a different ID appears in the Video Inbox under **Connect Tab Parker**. Confirm it once after comparing the ID with `chrome://extensions`. Until then, Inbox videos open directly on YouTube.
- **Moving to Tab Parker 1.3.11.** Hold your parked tabs with **Update Tab Parker safely**, replace Tab Parker, then restore them. Tab Atelier moves them to the new Tab Parker ID and keeps their titles and channels.

This release requires no new Chrome permissions.

1. Download the extension ZIP from Releases and extract it to a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`. Pin the extension if you want its popup in the toolbar.

For an update, keep the same local extension directory so Chrome retains the extension ID and its local settings. Back up your Inbox before changing installations.

The download includes the MIT license. See the README for features and privacy details.
