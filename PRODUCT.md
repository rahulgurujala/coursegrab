# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Electron desktop app for Windows, macOS and Linux; the renderer is HTML/CSS/JS.)

## Users
Udemy learners who want offline copies of courses they are already enrolled in: individual students, and employees on Udemy Business company subdomains. They start long, multi-course downloads and leave them running in the background, so they return to check progress, pause/resume, or fix a failed lecture.

## Product Purpose
CourseGrab logs the user into Udemy, lists the courses they are subscribed to, and downloads lecture videos, subtitles and attachments into an organised folder structure on disk. Success: the user finds a course fast, starts a download with the right options, trusts it is progressing, and ends with a complete, well-organised folder.

## Positioning
A free, ad-free, cross-platform desktop downloader with no accounts of its own. It only accesses courses the user is enrolled in, using their own Udemy authentication. Created and maintained by rahulgurujala; based on Udeler by Faisal Umair (FaisalUmair/udemy-downloader-gui, MIT, archived), renamed CourseGrab.

## Operating Context
- Sign-in methods: Udemy login window (credentials), an access token pasted by the user, or the original author's "Udeler Authenticator" Chrome extension talking to a local socket.io server inside the app. Udemy Business users supply a company subdomain.
- Views today: Login, Courses (search + list), Downloads (per-course progress, pause/resume/cancel), Settings, About, plus modals (subtitle language picker, update available) and full-screen loading states.
- Downloads are long-running; the window may be open for hours. Course lists can be large; search filters them.
- Interface language is user-selectable (English plus about 20 locales, including Arabic which mirrors the sidebar to the right, i.e. RTL support must be preserved). Strings are translated by English text key via `translate()` and `locale/*.json`.

## Capabilities and Constraints
- Settings: download path, download start/end lecture range, skip attachments, video quality (Auto, Lowest, 360p to 1080p, Highest), skip subtitles, auto retry (experimental), language.
- Window is resizable, default 1040x720, minimum 720x520 (confirmed; was fixed 550x700).
- UI is jQuery plus custom CSS (`assets/css/app.css`, tokens in DESIGN.md); Semantic UI was removed. Markup is static in `index.html`, rows are built by `assets/js/ui.js`, and the download engine in `assets/js/app.js` must keep working.
- Renderer runs with nodeIntegration and contextIsolation off (Electron 44); the Udemy login window is a separate default-sandboxed BrowserWindow.
- Existing app icons (`assets/images/build/icon.*`) are kept for now.

## Brand Commitments
Visual direction (user-confirmed): clean, modern, professional, simple but full-featured. No themed or decorative worlds. Craft bar: Apple Music/Podcasts (macOS), Raycast/Arc, Notion/Vercel dashboard, Linear. Light and dark themes, both polished, following the OS setting.
Name is CourseGrab. It is based on Udeler and keeps a small credit to Faisal Umair (README, About page, sign-in footer, LICENSE) next to the maintainer's name, rahulgurujala. No donate section. Tone is a plain utility: free, no ads, no accounts.

## Evidence on Hand
No customer quotes, benchmarks or usage data. Old demo GIF was removed. No screenshots or marketing assets for the new brand yet.

## Product Principles
1. Downloads are the product: progress, state and recovery must be legible at a glance and after hours away.
2. Never make the user hunt: finding a course and starting a download takes as few steps as possible.
3. Honest about limits: it only downloads what the user is enrolled in; errors and experimental options are stated plainly.
4. Works in every language and direction: layouts must hold up with long translations and RTL.
5. Feels trustworthy for handling a Udemy login: no surprises, clear sign-in and sign-out states.

## Accessibility & Inclusion
Keyboard operable, visible focus, sufficient contrast, and RTL (Arabic) support. Respect the OS light/dark preference.
