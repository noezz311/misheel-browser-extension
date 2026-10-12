# Third-party components

This extension includes the legacy browser build of Mozilla PDF.js **5.6.205**.
The original minified files are bundled as `vendor/pdfjs/pdf.mjs` and
`vendor/pdfjs/pdf.worker.mjs`, along with character maps, standard fonts and
WebAssembly decoders. PDF files are rendered locally in the extension.

- Project: https://mozilla.github.io/pdf.js/
- Source: https://github.com/mozilla/pdf.js
- Copyright: Mozilla Foundation and contributors.
- License: Apache License, Version 2.0; full text in `vendor/pdfjs/LICENSE`.

The matching PDF.js text-layer layout rules are adapted in `pdf.css` to support
selectable text. This notice applies to PDF.js components and does not assign a
license to the user-supplied Misheel dictionary.
