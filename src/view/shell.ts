// The rest of assets/js/ui.js: i18n application, view switching, toasts, the confirm dialog, and
// the Downloads badge/summary. The click/keydown wiring stays in assets/js/ui.js itself: it reaches
// into courseDetail (assets/js/details.js), which does not exist yet at the point ui.js's own
// top-level code runs (script load order: ui.js, app.js, engine.js, details.js), the same
// load-order constraint every other cross-file reference in this app already works around by
// resolving the name inside a callback, not at registration time. That is genuinely app-shell
// glue connecting not-yet-loaded modules, not view rendering, so it is not moved here.

import $ from "jquery";
import { esc } from "./esc";
import meta from "../../locale/meta.json";
import type { SettingsApi } from "../shared/types";

type Translate = (text: string) => string;

export interface ShellDeps {
  translate: Translate;
  appVersion: string;
  settings: SettingsApi;
  loadDownloads: () => void;
  loadSettings: () => void;
  saveDownloads: (immediate: boolean) => void;
}

export interface Shell {
  scroll: Record<string, number>;
  applyTranslations(): void;
  showView(name: string): void;
  toast(message: string, error?: boolean): void;
  confirm(title: string, text: string | undefined, okLabel: string, cb: (ok: boolean) => void): void;
  refreshDownloads(): void;
}

export function createShell(deps: ShellDeps): Shell {
  const { translate, appVersion, settings, loadDownloads, loadSettings, saveDownloads } = deps;
  const scroll: Record<string, number> = {};
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function applyTranslations(): void {
    const lang = settings.get("general.language") as string | undefined;
    if (lang && lang != "English") {
      $("[data-i18n]").each(function() {
        this.textContent = translate(this.textContent?.trim() || "");
      });
      $("[data-i18n-placeholder]").each(function() {
        (this as HTMLInputElement).placeholder = translate(this.getAttribute("data-i18n-placeholder") || "");
      });
      $("button[title], .nav-item[title]").each(function() {
        this.title = translate(this.title);
      });
      $("[data-i18n-aria]").each(function() {
        this.setAttribute("aria-label", translate(this.getAttribute("data-i18n-aria") || ""));
      });
      const file = (meta as Record<string, string>)[lang] || "";
      if (file) {
        document.documentElement.lang = file.split(".")[0]!.split("_")[0]!;
        if (["ar.json", "fa.json"].includes(file)) {
          document.documentElement.dir = "rtl";
        }
      }
    }
    $("#app-version").text(appVersion);
  }

  function showView(name: string): void {
    const from = $(".view.active").attr("id");
    if (from) scroll[from] = $("#main").scrollTop() || 0;
    $(".view").removeClass("active");
    $("#view-" + name).addClass("active");
    $(".nav-item").each(function() {
      const on = $(this).data("view") == (name == "course" ? "downloads" : name);
      if (on) this.setAttribute("aria-current", "page");
      else this.removeAttribute("aria-current");
    });
    $("#main").scrollTop(scroll["view-" + name] || 0);
    if (name == "downloads") loadDownloads();
    if (name == "settings") loadSettings();
  }

  function toast(message: string, error?: boolean): void {
    $("#toasts").empty();
    const $t = $(`<div class="toast${error ? " error" : ""}"${error ? ' role="alert"' : ""}>${esc(message)}</div>`).appendTo("#toasts");
    setTimeout(() => $t.fadeOut(200, () => $t.remove()), error ? 6000 : 2600);
  }

  function confirm(title: string, text: string | undefined, okLabel: string, cb: (ok: boolean) => void): void {
    const dlg = document.getElementById("dlg-confirm") as HTMLDialogElement;
    $("#dlg-confirm-title").text(title);
    $("#dlg-confirm-text").text(text || "").toggle(!!text);
    $("#dlg-confirm-ok").text(okLabel);
    dlg.returnValue = "";
    dlg.onclose = () => cb(dlg.returnValue == "ok");
    dlg.showModal();
  }

  // Badge, summary line, empty state and "clear finished" for the Downloads view.
  function refreshDownloads(): void {
    const $rows = $("#downloads-list > .course");
    const count = (s: string) => $rows.filter(`[data-state="${s}"]`).length;
    const active = count("downloading") + count("paused") + count("preparing");
    const failed = count("error");
    const done = count("done");
    const interrupted = count("interrupted");
    const $badge = $("#downloads-badge");
    if (active || failed) {
      $badge
        .text(String(active || failed))
        .toggleClass("alert", !active && !!failed)
        .prop("hidden", false);
    } else {
      $badge.prop("hidden", true);
    }
    const parts: string[] = [];
    if (active) parts.push(`<bdi>${active}</bdi> ${esc(translate("active"))}`);
    if (done) parts.push(`<bdi>${done}</bdi> ${esc(translate("completed"))}`);
    if (failed) parts.push(`<bdi>${failed}</bdi> ${esc(translate("failed"))}`);
    if (interrupted) parts.push(`<bdi>${interrupted}</bdi> ${esc(translate("interrupted"))}`);
    $("#downloads-summary").html(parts.join(" · "));
    $('.nav-item[data-view="downloads"]').attr(
      "aria-label",
      translate("Downloads") + (active ? `, ${active} ${translate("active")}` : failed ? `, ${failed} ${translate("failed")}` : "")
    );
    $("#downloads-empty").prop("hidden", !!$rows.length);
    $("#clear-finished").prop("hidden", !done);
    // keep the list on disk, so an unexpected quit still leaves resumable rows behind
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!$("#app").prop("hidden")) saveDownloads(false);
    }, 1500);
  }

  return { scroll, applyTranslations, showView, toast, confirm, refreshDownloads };
}
