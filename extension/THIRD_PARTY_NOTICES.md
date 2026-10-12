# Third-party components

This extension includes the legacy browser build of Mozilla PDF.js **5.6.205**.
The browser files are bundled as `vendor/pdfjs/pdf.mjs`,
`vendor/pdfjs/pdf.worker.mjs`, `vendor/pdfjs/pdf_viewer.mjs` and
`vendor/pdfjs/pdf_viewer.css`, along with viewer images, character maps,
standard fonts and WebAssembly decoders. PDF files are rendered and annotated
locally in the extension.

- Project: https://mozilla.github.io/pdf.js/
- Source: https://github.com/mozilla/pdf.js
- Copyright: Mozilla Foundation and contributors.
- License: Apache License, Version 2.0; full text in `vendor/pdfjs/LICENSE`.

The matching PDF.js viewer supports selectable text and standard PDF annotation
editing. The following additional components generate saved text-note appearances
so Korean and Mongolian notes remain visible in other PDF readers.

## pdf-lib 1.17.1

- Project/source: https://github.com/Hopding/pdf-lib
- Bundled file: `vendor/pdf-lib/pdf-lib.min.js`.
- Copyright: Andrew Dillon.
- License: MIT; full text in `vendor/pdf-lib/LICENSE.md`.

## @pdf-lib/fontkit 1.1.1

- Project/source: https://github.com/Hopding/fontkit (fork of https://github.com/foliojs/fontkit).
- Bundled file: `vendor/fontkit/fontkit.umd.min.js`.
- Authors: Andrew Dillon, Devon Govett and contributors.
- License: MIT; license text and attribution in `vendor/fontkit/LICENSE.txt`.

## Noto Sans KR Regular 2.004

- Source: https://github.com/notofonts/noto-cjk/tree/main/Sans/SubsetOTF/KR
- Bundled file: `vendor/fonts/NotoSansKR-Regular.otf`.
- Copyright: 2014–2021 Adobe.
- License: SIL Open Font License 1.1; full text in `vendor/fonts/LICENSE.txt`.

## Noto Sans Regular 2.008

- Source: https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans
- Bundled file: `vendor/fonts/NotoSans-Regular.ttf`.
- Copyright: 2015–2021 Google LLC; Noto Project Authors.
- License: SIL Open Font License 1.1; full text in `vendor/fonts/LICENSE-NotoSans.txt`.

Fonts and libraries are bundled for offline use. This notice applies to the
components above and does not assign a license to the user-supplied Misheel
dictionary.
