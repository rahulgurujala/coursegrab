# CourseGrab | Udemy Course Downloader (GUI)

A cross platform (Windows, Mac, Linux) desktop application for downloading the Udemy courses you are enrolled in.

> **Fork notice.** CourseGrab is a maintained fork of [FaisalUmair/udemy-downloader-gui](https://github.com/FaisalUmair/udemy-downloader-gui) (formerly known as **Udeler**), which is archived and no longer maintained. Thanks to Faisal Umair and the original contributors. This fork is renamed, migrated to bun and Electron 44, and continues development here. Bugs and feature requests: [issues](https://github.com/rahulgurujala/coursegrab/issues).

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

### Downloads:

No prebuilt binaries have been published for CourseGrab yet. Build from source (see below); releases will appear on the [Releases](https://github.com/rahulgurujala/coursegrab/releases) page.

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

Original project by [Faisal Umair](https://github.com/FaisalUmair) ([FaisalUmair/udemy-downloader-gui](https://github.com/FaisalUmair/udemy-downloader-gui)), released under the MIT License. See [LICENSE](LICENSE).
