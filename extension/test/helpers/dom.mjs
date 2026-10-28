// The converters and the scan run in the browser; give Node the DOM globals
// they use. Browsers wrap an HTML fragment in <html><body>; linkedom needs it
// spelled out.
import { DOMParser, parseHTML } from 'linkedom';

globalThis.DOMParser = class extends DOMParser {
  parseFromString(text, type) {
    return super.parseFromString(type === 'text/html' ? `<!doctype html><html><body>${text}</body></html>` : text, type);
  }
};
globalThis.Node = parseHTML('<html></html>').Node;
