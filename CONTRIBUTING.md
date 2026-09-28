# Contributing to CourseGrab

Thank you for helping improve CourseGrab. Bug reports, translations, documentation and code are all welcome. This guide explains how the project is organised and how to get a change merged.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug.** [Open an issue](https://github.com/rahulgurujala/coursegrab/issues/new) and include your operating system, the CourseGrab version (Settings, About), what you did, what you expected and what happened. Screenshots help. Never paste your access token.
- **Suggest a feature.** Open an issue that describes the problem you want solved, not only the solution.
- **Translate the app.** See [Translations](#translations).
- **Improve the docs.** Fixes to the README, this guide or the in-app text are always useful.
- **Send code.** For anything larger than a small fix, open an issue first so we can agree on the approach.

## Set up your environment

You need [Bun](https://bun.sh) 1.x, [Node.js](https://nodejs.org) 22 or newer, and Git.

```sh
git clone https://github.com/rahulgurujala/coursegrab.git
cd coursegrab
bun install
git switch dev
bun start
```

Run the app against a throwaway data folder so your real settings and login are never touched:

```sh
COURSEGRAB_USER_DATA=/tmp/coursegrab-dev bun start
```

### Project layout

| Path | Purpose |
| ---- | ------- |
| `index.js` | Electron main process: window, menu, data folder |
| `index.html` | Static markup for every screen and dialog |
| `assets/js/app.js` | Sign in, course list, settings, download controls |
| `assets/js/engine.js` | Download engine: reads a course, plans updates, saves files |
| `assets/js/ui.js` | Views, dialogs, toasts and the course row component |
| `assets/js/settings.js` | Settings file in the user data folder |
| `assets/css/app.css` | All styles, with light and dark themes |
| `locale/` | Translations |
| `PRODUCT.md`, `DESIGN.md` | Who the app is for, and the design system |

## Branches and pull requests

- `dev` is where all work is merged. Branch from `dev` and open your pull request against `dev`.
- `main` only receives releases. Do not open pull requests against `main`. The CI check rejects them unless they come from `dev`.
- Use a short, descriptive branch name such as `fix/token-paste` or `feat/download-all`.
- Keep pull requests focused. One change per pull request is easier to review and easier to release.
- Pull requests into `dev` are squash merged, so the **pull request title** becomes the changelog entry.

### Commit and pull request titles

Titles follow [Conventional Commits](https://www.conventionalcommits.org). The type decides the next version number and where the change shows in the changelog.

| Type | Use it for | Version bump | In changelog |
| ---- | ---------- | ------------ | ------------ |
| `feat:` | A new feature | minor | Features |
| `fix:` | A bug fix | patch | Bug Fixes |
| `perf:` | A performance improvement | patch | Performance |
| `refactor:` | A code change with no behaviour change | none | Refactoring |
| `docs:` | Documentation only | none | Documentation |
| `chore:`, `ci:`, `test:`, `style:`, `build:` | Maintenance | none | hidden |

Add `!` after the type (`feat!: ...`) or a `BREAKING CHANGE:` line in the body for a change that breaks existing behaviour. That bumps the major version.

Examples:

```text
feat: add a keyboard shortcut for the Downloads view
fix(login): accept a token pasted with quotes
docs: explain the folder layout in the README
```

A CI check validates the title of every pull request.

## Code guidelines

- The app is plain JavaScript with jQuery, and the styles are hand written CSS. Please match the surrounding code instead of introducing new frameworks.
- **Interface text** goes through `translate("English text")` in JavaScript or `data-i18n` in `index.html`, so it can be translated. The English text is the key.
- **Styles** use the tokens at the top of `assets/css/app.css` and follow [DESIGN.md](DESIGN.md). Do not hard code colors, sizes or radii. Check both light and dark themes.
- **Layout** uses logical properties (`margin-inline-start`, not `margin-left`) so right to left languages mirror correctly.
- **Accessibility:** every control needs a keyboard path, a visible focus state and an accessible name. Icon only buttons need an `aria-label` and a `title`.
- **The download engine** in `assets/js/engine.js` handles real files on disk. Change it carefully and test pause, resume, cancel, completion and a second download of the same course (only new or changed lectures should be fetched).
- Do not add dependencies for something a few lines can do.

## Testing your change

There is no automated UI test suite yet. Before you open a pull request:

1. Run the app with a throwaway data folder (see above) and try your change by hand, in both light and dark themes.
2. For UI changes, check a narrow window as well (the minimum size is 720 by 520).
3. Run the syntax check that CI runs:

   ```sh
   for f in index.js assets/js/*.js; do node --check "$f"; done
   ```

4. For packaging changes, build once on your system, for example `bun run build-mac`.

Include screenshots in the pull request for anything visual.

## Translations

Translations live in `locale/`, one JSON file per language. The keys are the English strings and the values are the translated text.

**Improve an existing language:** edit its file, for example `locale/de.json`, and fill in or correct the values. Missing keys fall back to English, so partial translations are fine.

**Add a new language:**

1. Copy `locale/template.json` to `locale/<code>.json` (for example `locale/nl.json`) and fill in the values.
2. Add the language to `locale/meta.json`, using its name in its own language as the key and the file name as the value.
3. For a right to left language, also add its file name to the right to left list in `assets/js/ui.js` (search for `ar.json`).

When you add new interface text in code, add the English key to `locale/template.json` too.

## Releases

Releases are automatic and are handled by the maintainer.

1. Pull requests are merged into `dev`.
2. When a release is due, a pull request from `dev` to `main` is opened and merged with a **merge commit**, not a squash, so each change keeps its own changelog line.
3. [release-please](https://github.com/googleapis/release-please) then opens a **Release PR** on `main` with the new version and the changelog.
4. Merging that Release PR creates the tag (`vX.Y.Z`) and the GitHub Release. The same workflow builds installers for macOS, Windows and Linux and attaches them to the release. Installers are unsigned for now.
5. A follow-up pull request merges `main` back into `dev`.

## Questions

Open an issue or start a discussion on GitHub. Please be patient: CourseGrab is maintained in spare time.
