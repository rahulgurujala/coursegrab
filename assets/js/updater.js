// Checks GitHub for a newer release on every launch and on demand (the About page button), and
// drives the update banner. "Is a new version out" is answered the same simple way on every
// platform (compare the latest release tag with the running version); actually fetching and
// installing that update is only possible on Windows and Linux (see index.js for why not macOS).
//
// Loaded after app.js, which provides: $, ui, translate, esc, electron, appVersion.

var updater = (function() {
  var REPO = "rahulgurujala/coursegrab";
  var latestSeen = null; // the release info from the most recent check, so a second click reuses it
  var checking = false;
  var state = "idle"; // idle | available | downloading | downloaded | error

  function platformSupportsAutoUpdate() {
    return process.platform !== "darwin";
  }

  function assetFor(release) {
    var byArch = {
      darwin: process.arch === "arm64" ? /mac-arm64\.dmg$/ : /mac-x64\.dmg$/,
      win32: /win-x64\.exe$/,
      linux: /linux-x86_64\.AppImage$/
    }[process.platform];
    var assets = release.assets || [];
    var match = byArch && assets.find(function(a) {
      return byArch.test(a.name);
    });
    return (match && match.browser_download_url) || release.html_url;
  }

  function setActions(html) {
    $("#update-actions").html(html);
  }

  function show(title, sub) {
    $("#update-title").text(title);
    $("#update-sub").text(sub || "");
    $("#update-banner").prop("hidden", false);
  }

  function hide() {
    $("#update-banner").prop("hidden", true);
    $("#update-progress-track").prop("hidden", true);
  }

  function renderAvailable(release) {
    state = "available";
    show(translate("Update available") + ": " + release.tag_name, release.name && release.name != release.tag_name ? release.name : "");
    $("#update-progress-track").prop("hidden", true);
    if (platformSupportsAutoUpdate()) {
      setActions(
        '<button class="btn primary" type="button" id="update-go">' + esc(translate("Update")) + "</button>"
      );
    } else {
      setActions(
        '<button class="btn primary" type="button" id="update-open">' + esc(translate("Download")) + "</button>"
      );
    }
  }

  function renderDownloading(percent) {
    state = "downloading";
    show(translate("Downloading update") + "…", "");
    $("#update-progress-track").prop("hidden", false);
    $("#update-progress-fill").css("width", (percent || 0) + "%");
    setActions("");
  }

  function renderDownloaded() {
    state = "downloaded";
    show(translate("Update ready"), translate("Restart to finish installing it."));
    $("#update-progress-track").prop("hidden", true);
    setActions(
      '<button class="btn primary" type="button" id="update-restart">' + esc(translate("Restart & update")) + "</button>"
    );
  }

  function renderError(message) {
    state = "error";
    show(translate("Could not update"), message || "");
    $("#update-progress-track").prop("hidden", true);
    setActions('<button class="btn" type="button" id="update-open">' + esc(translate("Download")) + "</button>");
  }

  // Compares the latest GitHub release tag with the running version. Same check on every
  // platform: it only answers "is something newer out", never downloads anything.
  function check(auto) {
    if (checking) return;
    checking = true;
    var $btn = $("#check-updates");
    if (!auto) {
      $btn.prop("disabled", true);
      $("#update-status").text(translate("Checking for Updates") + "…");
    }
    $.getJSON("https://api.github.com/repos/" + REPO + "/releases/latest")
      .done(function(release) {
        latestSeen = release;
        if (release.tag_name != "v" + appVersion) {
          if (!auto) $("#update-status").text(translate("New Update Available") + ": " + release.tag_name);
          renderAvailable(release);
        } else {
          if (!auto) $("#update-status").text(translate("No updates available"));
        }
      })
      .fail(function(xhr) {
        if (!auto) {
          $("#update-status").text(
            xhr.status == 404 ? translate("No updates available") : translate("Could not check for updates.")
          );
        }
      })
      .always(function() {
        checking = false;
        if (!auto) $btn.prop("disabled", false);
      });
  }

  $("#check-updates").click(function() {
    check(false);
  });

  $(document).on("click", "#update-open", function() {
    var url = (latestSeen && assetFor(latestSeen)) || "https://github.com/" + REPO + "/releases/latest";
    electron.shell.openExternal(url);
  });

  $(document).on("click", "#update-go", function() {
    renderDownloading(0);
    electron.ipcRenderer.send("update:download");
  });

  $(document).on("click", "#update-restart", function() {
    electron.ipcRenderer.send("update:install");
  });

  $("#update-dismiss").click(hide);

  if (platformSupportsAutoUpdate()) {
    electron.ipcRenderer.on("update:progress", function(e, percent) {
      renderDownloading(percent);
    });
    electron.ipcRenderer.on("update:downloaded", function() {
      renderDownloaded();
    });
    electron.ipcRenderer.on("update:error", function(e, message) {
      renderError(message);
    });
  }

  // Silent check shortly after launch; never interrupts sign-in or an active download with a
  // popup, the banner just appears if there is something to see.
  setTimeout(function() {
    check(true);
  }, 4000);

  return { check: check };
})();
