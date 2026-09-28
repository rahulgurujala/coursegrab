<p align="center"><img src="assets/images/logo.svg" alt="CourseGrab logo" width="96"></p>

# CourseGrab | Udemy Course Downloader (GUI)

A cross platform (Windows, Mac, Linux) desktop application for downloading the Udemy courses you are enrolled in.

<sub>Created and maintained by [rahulgurujala](https://github.com/rahulgurujala). Based on Udeler by [Faisal Umair](https://github.com/FaisalUmair/udemy-downloader-gui) (MIT, archived). Bugs and feature requests: [issues](https://github.com/rahulgurujala/coursegrab/issues).</sub>

### Facing Login Issues?

Besides the built-in login window, you can log in through the **Udeler Authenticator** browser extension made by the original author (a chrome extension for authenticating a Udemy account with the desktop app).

#### How to use the Authenticator extension?

1. Install the extension from [here](https://www.udeler.com/extension) (original author's site; availability is not guaranteed).

2. After installing/enabling the extension, open the CourseGrab desktop app, you will see a new anonymous icon on the login page. Click the icon and it will start to listen for any login requests from your chrome web browser.

3. Open Udemy website on your chrome web browser and simply login to your account. CourseGrab will detect the login and will let you in. If you are already logged in to Udemy, you can simply visit the website and it will still detect your account.

### :fire: Features

- _`Choose video quality.`_
- _`Download multiple courses at once.`_
- _`Set Download Start and Download End.`_
- _`Pause/Resume download at any time.`_
- _`Choose download directory.`_
- _`Multilingual (English,Italian,Spanish).`_

### Disclaimer:

This software is intended to help you download Udemy courses for personal use only. Sharing the content of your subscribed courses is strictly prohibited under Udemy Terms of Use. Each and every course on Udemy is subjected to copyright infringement.
This software does not magically download any paid course available on Udemy, you need to provide your Udemy login credentials to download the courses you have enrolled in. CourseGrab downloads the lecture videos by simply using the source of the video player returned to the user by Udemy after proper authentication, you can also do the same manually. Many download managers use same method to download videos on a web page. This app only automates the process of a user doing this manually in a web browser.

### Installation

Download the installer for your system from the [latest release](https://github.com/rahulgurujala/coursegrab/releases/latest):

| System | File |
| ------ | ---- |
| macOS, Apple Silicon (M1, M2, M3, M4) | `CourseGrab-<version>-mac-arm64.dmg` |
| macOS, Intel | `CourseGrab-<version>-mac-x64.dmg` |
| Windows 64-bit | `CourseGrab-<version>-win-x64.exe` |
| Linux 64-bit | `CourseGrab-<version>-linux-x86_64.AppImage` |

Only download installers from the Releases page above.

#### Why does my system show a warning?

The installers are **not code-signed yet**. Signing certificates cost money, and CourseGrab is a free project. Your system therefore shows a warning the first time you open it. It does not mean the file is damaged or unsafe. Follow the steps for your system:

**macOS**

1. Open the `.dmg` and drag **CourseGrab** into **Applications**.
2. Open CourseGrab from Applications. macOS says it "can't be opened" or "cannot verify the developer". Close that message.
3. Open **System Settings → Privacy & Security** (on macOS 12 or older: **System Preferences → Security & Privacy → General**).
4. Scroll to the **Security** section, find the message about CourseGrab and click **Open Anyway**. Enter your password if asked, then click **Open**.

If macOS says the app is **"damaged and can't be opened"** and there is no Open Anyway button, remove the download flag in Terminal and open the app again:

```
xattr -dr com.apple.quarantine /Applications/CourseGrab.app
```

You only need to do this once.

**Windows**

1. Run the `.exe`. A blue window says **"Windows protected your PC"**.
2. Click **More info**, then **Run anyway**.
3. Finish the installer as usual.

Some antivirus programs flag unsigned installers by mistake. If yours does, you can allow the file or [build CourseGrab from source](#build).

**Linux**

1. Make the AppImage runnable and start it:

   ```
   chmod +x CourseGrab-*.AppImage
   ./CourseGrab-*.AppImage
   ```

2. If it fails with a **FUSE** error, install FUSE (`sudo apt install libfuse2`, or `libfuse2t64` on Ubuntu 24.04), or run it without FUSE:

   ```
   ./CourseGrab-*.AppImage --appimage-extract-and-run
   ```

3. If it stops with a **sandbox** error on Ubuntu 24.04 or newer, start it with `--no-sandbox`:

   ```
   ./CourseGrab-*.AppImage --no-sandbox
   ```

If you used Udeler before, CourseGrab keeps your existing settings and login.

### Note:

By default the courses will be downloaded to the user's Download folder. The structure of course content will be preserved.

# For Developers

### Contributing:

Any contributions are welcome, if you plan to contribute please read the [contributing](https://github.com/rahulgurujala/coursegrab/blob/main/CONTRIBUTING.md) docs first.

### Prerequisites:

```
You must have [bun](https://bun.sh) and Node.js installed.
```

### To use the application:

```
1. Clone the project
2. Run bun install
3. Run bun start
```

### Build:

Detect Platform:

```
bun run dist
```

Windows:

```
bun run build-win
```

Mac:

```
bun run build-mac
```

Linux:

```
bun run build-linux
```

Cross Platform:

```
bun run build
```

#### To force 32 bit build:

_Append "--ia32" to bun run command_

Example:

```
bun run build-win --ia32
```

## Credits

Created and maintained by [rahulgurujala](https://github.com/rahulgurujala). Based on Udeler by [Faisal Umair](https://github.com/FaisalUmair/udemy-downloader-gui) and its contributors, released under the MIT License. See [LICENSE](LICENSE).
