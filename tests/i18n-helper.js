// The retained pre-localization regression fixtures assert German messages.
// Supply Chrome's real message lookup shape using the bundled German catalog.
import fs from 'node:fs';
import '../i18n-core.js';
const messages = JSON.parse(fs.readFileSync(new URL('./legacy-messages.json', import.meta.url), 'utf8'));
globalThis.atelierI18n = globalThis.atelierCreateI18n({
  getUILanguage: () => 'de',
  getMessage(key, values = []) {
    const record = messages[key];
    if (!record) return '';
    let message = record.message;
    for (const [name, placeholder] of Object.entries(record.placeholders || {})) {
      const content = placeholder.content.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] ?? '');
      message = message.replace(new RegExp(`\\$${name}\\$`, 'gi'), content);
    }
    return message.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] ?? '');
  }
});
