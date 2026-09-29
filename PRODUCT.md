# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

An Electron desktop app for Windows, macOS and Linux. The renderer is HTML, CSS and JavaScript.

## Users
Udemy learners who want offline copies of courses they are already enrolled in: individual students, and employees on Udemy Business company subdomains. They start long, multi-course downloads and leave them running in the background, so they return to check progress, pause or resume, or fix a failed lecture.

## Product Purpose
CourseGrab logs the user into Udemy, lists the courses they are subscribed to, and downloads lecture videos, subtitles and attachments into an organised folder structure on disk. Success: the user finds a course fast, starts a download with the right options, trusts it is progressing, and ends with a complete, well-organised folder. Downloading the same course again fetches only what is new or changed.

## Positioning
A free, ad-free, cross-platform desktop downloader with no accounts of its own. It only accesses courses the user is enrolled in, using their own Udemy authentication. Created and maintained by rahulgurujala; based on Udeler by Faisal Umair (FaisalUmair/udemy-downloader-gui, MIT, archived), renamed CourseGrab.

## Operating Context
- Sign-in methods: Udemy login window (credentials; the app watches for the access_token cookie) or an access token pasted by the user. Udemy Business users supply a company subdomain.
- Views: Sign in, Courses (search and list), Downloads (per-course progress with pause, resume, cancel, open folder and retry), a course details view (every lecture with its live state, and a dry-run comparison with Udemy), Settings and About, plus dialogs for the subtitle language and logout confirmation, and an update banner shown on any view.
- Downloads are long-running; the window may be open for hours. Course lists can be large; search filters them.
- Some lectures cannot be downloaded (for example DRM protected video). They are skipped and listed, never allowed to block the rest of the course. CourseGrab does not decrypt protected content.
- A lecture that fails for another reason (a dropped connection, a server error) does not stop the rest of the course either. It is marked failed, with its own Retry action in the course details view, and a course-level Retry only re-attempts what failed or was missing, not the whole course.
- Each course folder holds a `.coursegrab.json` record so a later run can detect new, replaced or renamed lectures. Interrupted downloads resume from the data already saved.
- The app checks GitHub for a newer release on launch and on demand. Windows and Linux builds can download and install that update themselves (electron-updater); macOS builds are unsigned and cannot self-update, so macOS only offers a link to the new version's download page.
- Interface language is user-selectable (English plus more than 20 locales, including Arabic and Persian, so right to left support must be preserved). Strings are translated by English text key through `translate()` and `locale/*.json`.

## Capabilities and Constraints
- Settings: download path, video quality (Auto, Highest, 1080p to 360p, Lowest), subtitles on or off, attachments on or off, lecture range, auto retry (experimental), language. They save as they change.
- The window is resizable: default 1040 by 720, minimum 720 by 520.
- UI is jQuery plus custom CSS (`assets/css/app.css`, tokens in DESIGN.md); Semantic UI was removed. Markup is static in `index.html`, rows are built by `assets/js/ui.js`, and the download engine in `assets/js/engine.js` must keep working.
- The renderer runs with nodeIntegration on and contextIsolation off (Electron 44). The Udemy sign in window is a separate, default-sandboxed BrowserWindow.
- Settings and the saved login live in a user data folder named `Udeler`, kept from the earlier version so existing users stay signed in.
- Releases are automated: `dev` receives work, `main` receives releases, and release-please builds the changelog and version (see CONTRIBUTING.md).
- App logo: a "C" holding a play button on a cobalt rounded square (`assets/images/logo.svg`; app icons in `assets/images/build/` are generated from `icon.svg` with `bunx electron scripts/make-icons.js`).

## Brand Commitments
Visual direction (user-confirmed): clean, modern, professional, simple but full-featured. No themed or decorative worlds. Craft bar: Apple Music/Podcasts (macOS), Raycast/Arc, Notion/Vercel dashboard, Linear. Light and dark themes, both polished, following the OS setting.
The name is CourseGrab. It is based on Udeler and keeps a small credit to Faisal Umair (README, About page, sign in footer, LICENSE) next to the maintainer's name, rahulgurujala. There is no donate section. The tone is a plain utility: free, no ads, no accounts. Copy and documentation avoid em dashes.

## Evidence on Hand
No customer quotes, benchmarks or usage data. README screenshots in `docs/images/` use synthetic sample courses, never a real account.

## Product Principles
1. Downloads are the product: progress, state and recovery must be legible at a glance and after hours away.
2. Never make the user hunt: finding a course and starting a download takes as few steps as possible.
3. Honest about limits: it only downloads what the user is enrolled in; errors and experimental options are stated plainly.
4. Works in every language and direction: layouts must hold up with long translations and RTL.
5. Feels trustworthy for handling a Udemy login: no surprises, clear sign-in and sign-out states.

## Accessibility & Inclusion
Keyboard operable, visible focus, sufficient contrast, and right to left support. Respect the operating system light or dark preference.
