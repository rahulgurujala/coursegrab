# Changelog

## [2.1.0](https://github.com/rahulgurujala/coursegrab/compare/v2.0.0...v2.1.0) (2026-09-28)


### Features

* new CourseGrab logo ([#14](https://github.com/rahulgurujala/coursegrab/issues/14)) ([d92c5c9](https://github.com/rahulgurujala/coursegrab/commit/d92c5c9214d577c319638c5a100b71b317c5c91b))
* skip protected lectures, resume interrupted downloads, download only new or changed content and a course details view ([#19](https://github.com/rahulgurujala/coursegrab/issues/19)) ([c4a37ab](https://github.com/rahulgurujala/coursegrab/commit/c4a37ab8fcb2ba67f8b85feafafaadbaf39e06cd))


### Bug Fixes

* sign in by watching the Udemy access_token cookie and verify tokens before accepting them ([#11](https://github.com/rahulgurujala/coursegrab/issues/11)) ([2d3a64f](https://github.com/rahulgurujala/coursegrab/commit/2d3a64f6fc407447815f0a18a3bc30103c6fdf21))


### Refactoring

* remove the Udeler Authenticator extension and its local server ([#15](https://github.com/rahulgurujala/coursegrab/issues/15)) ([580b84c](https://github.com/rahulgurujala/coursegrab/commit/580b84c35a57f800e8c74fd6eef56ba11db5998f))


### Documentation

* add installation steps and workarounds for unsigned installers ([#13](https://github.com/rahulgurujala/coursegrab/issues/13)) ([160c752](https://github.com/rahulgurujala/coursegrab/commit/160c75288ae2f2f71f99c56fe6c7820c4151a196))
* credit the maintainer first and keep the original author's credit small ([#12](https://github.com/rahulgurujala/coursegrab/issues/12)) ([7523fc1](https://github.com/rahulgurujala/coursegrab/commit/7523fc14100e85fecbe4827c4e9a5285538b41ac))
* rewrite the README and project docs ([#16](https://github.com/rahulgurujala/coursegrab/issues/16)) ([638b1a5](https://github.com/rahulgurujala/coursegrab/commit/638b1a5a20d5366ee17b1c8d5433adc8be8a2f9e))

## [2.0.0](https://github.com/rahulgurujala/coursegrab/compare/v1.8.2...v2.0.0) (2026-09-28)


### ⚠ BREAKING CHANGES

* the app and package are now called CourseGrab. Existing settings and login are kept.

### Features

* migrate package manager from npm to bun ([3f74b3a](https://github.com/rahulgurujala/coursegrab/commit/3f74b3a98156014adbf68f145c2ad38d78d8efd2))
* rebrand Udeler to CourseGrab ([e5ee518](https://github.com/rahulgurujala/coursegrab/commit/e5ee518c579b0dec389d3fb67f870e3e02821b63))
* redesign the UI with light and dark themes ([9e63971](https://github.com/rahulgurujala/coursegrab/commit/9e63971162e18e78e7aec30d60e16fef69e6628d))
* upgrade Electron 8 to 44 and electron-builder to 26 ([d4a850c](https://github.com/rahulgurujala/coursegrab/commit/d4a850cd8cdf3f448ce9a43ba7db005222be0bc2))


### Bug Fixes

* restore dot-path settings keys and apply the Business subdomain to API calls ([97e51d4](https://github.com/rahulgurujala/coursegrab/commit/97e51d4768256b9a1409cdb4f7299da77efae871))
